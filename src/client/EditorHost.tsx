/**
 * The editor tab host: the single FILES WINDOW. It resolves a file's
 * previewer through the sidebar registry (`matchFileViewer`), fetches bytes
 * per the matched viewer's fetch strategy, and renders its component — or
 * the shared download pane when nothing can render the file. A tab without
 * a path (the seeded "Files" home) renders an empty-state hint instead of
 * the viewer loading flow; that path-less window IS the file explorer.
 *
 * The chrome depends on the `editorExplorer` mode (read reactively so
 * toggling it re-renders without a reload):
 * - merged (in-place): tree click / path-input Enter switch the CURRENT
 *   tab in place (updateTab rewrites path/title; the tab keeps its id and
 *   meta, so treeOpen/treeWidth survive the switch);
 * - split: they open through `openSidebarFile` (a per-path dedupe tab),
 *   and a PATH-LESS window is the standalone explorer — it renders ONLY
 *   the tree panel (search + FileTree, full-window), no editor chrome.
 *   Editor tabs (with a path) keep the full chrome in both modes.
 * The tree's context menu offers the explicit escapes in both modes: open
 * in a new tab (per-path dedupe) or to the side (a fresh tab in a fresh
 * rightward split of the current pane).
 *
 * The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
 * editor-load.ts); this component only wires it to the host APIs.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createElement } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16, IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, mediaUrl, type SessionScope } from './api.ts'
import { BinaryDownload } from './binary-download.tsx'
import { planFirstMatch, planFsReadOutcome, type EditorLoadAction } from './editor-load.ts'
import { changeMatchesPath, unlinkCoversPath, useFsEvents } from './fs-events.ts'
import { baseName } from './FileTree.tsx'
import { openSidebarFile } from './intercept.tsx'
import { TreePanel } from './TreePanel.tsx'
import { t } from './locales.ts'
import { relativeTo } from './paths.ts'
import { resolveSidebarPath } from './produced-files.ts'
import type { EditorToolbarControls, EditorToolbarState, FileViewerDescriptor } from './service.ts'
import { firstLeaf, insertLeafAt, leafWithTab, mintTabId, treeOf, type SidebarStore, type SidebarTab } from './state.ts'
import css from './sidebar.module.css'

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown }
  | { status: 'binary' }

/** The docked tree panel's width bounds (drag-resize clamps into them). */
const TREE_WIDTH_DEFAULT = 240
const TREE_WIDTH_MIN = 160
const TREE_WIDTH_MAX = 480

/** The tab's persisted meta object (a malformed meta reads as empty). */
function metaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** Read the persisted tree-panel flag of one editor tab: an explicit
 *  boolean meta wins; otherwise path-less tabs (the seeded home) default
 *  open and file tabs default closed. */
function treeOpenOf(tab: SidebarTab): boolean {
  const treeOpen = metaOf(tab).treeOpen
  return typeof treeOpen === 'boolean' ? treeOpen : (tab.path === undefined || tab.path === '')
}

/** Read the persisted tree-panel width (clamped; default 240). */
function treeWidthOf(tab: SidebarTab): number {
  const width = metaOf(tab).treeWidth
  return typeof width === 'number' && Number.isFinite(width)
    ? Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(width)))
    : TREE_WIDTH_DEFAULT
}

/** Merge a patch into the tab's persisted meta (rides the layout). */
function patchMeta(ctx: Context, tab: SidebarTab, patch: Record<string, unknown>): void {
  ctx.betterSidebar?.updateTab(tab.id, { meta: { ...metaOf(tab), ...patch } })
}

/** Clamp one dock width into the contract range. */
function clampTreeWidth(value: number): number {
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(value)))
}

export function EditorHost(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  expanded: string[]
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string) => void
}) {
  const { ctx, store, scope, tab, expanded, onToggleDir, onReferenceFile } = props
  const path = tab.path ?? ''
  const title = tab.title
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  /**
   * Disk-vs-buffer notice for the open file, driven by the session's
   * fs-events feed:
   * - 'ok' — nothing to report;
   * - 'changed' — the file changed on disk while the editor had UNSAVED
   *   edits (auto-reload would drop them; the banner offers the explicit
   *   reload that knowingly discards them);
   * - 'deleted' — the file was removed (or renamed away) on disk; the banner
   *   offers a reload in case it comes back.
   */
  const [diskNotice, setDiskNotice] = useState<'ok' | 'changed' | 'deleted'>('ok')
  /** Bump to re-fetch the CURRENT path from the host (external change). */
  const [reloadTick, setReloadTick] = useState(0)
  /** The last successfully rendered load — lets a reload skip the "loading"
   *  flash (the old content stays until the fresh bytes arrive). */
  const lastReadyRef = useRef<{ path: string } | null>(null)

  // Reactive prefs read: flipping editorExplorer re-renders this tab with no
  // reload. The snapshot is the bare boolean so unrelated store churn never
  // re-renders the editor.
  const inPlace = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.editorExplorer, [store]),
  )
  // A path-less tab shows the empty-state hint in merged mode — and in split
  // mode it is the standalone explorer (tree-only, see the render below).
  const showEmpty = path === ''
  const treeOnly = showEmpty && !inPlace

  /**
   * Open a file from THIS window (tree click / search row / path input):
   * merged mode switches this tab in place (stable id, meta survives);
   * split mode opens a per-path dedupe tab through openSidebarFile.
   */
  const openFile = (absolute: string): void => {
    if (inPlace) {
      ctx.betterSidebar?.updateTab(tab.id, { path: absolute, title: baseName(absolute) })
    } else {
      openSidebarFile(ctx, store, scope.sessionId, absolute)
    }
  }

  /** The context menu's explicit "new tab" escape (per-path dedupe). */
  const openFileNewTab = (absolute: string): void => {
    openSidebarFile(ctx, store, scope.sessionId, absolute)
  }

  /**
   * The context menu's "open to the side": a fresh editor tab (uid id — the
   * `'editor:' + path` convention would clash with the id safety net on a
   * second side-open of the same file) in a rightward split of THIS pane.
   */
  const openFileSide = (absolute: string): void => {
    store.reduce((state) => {
      const key = treeOf(state, tab.id)
      const pane = leafWithTab(state[key], tab.id) ?? firstLeaf(state[key])
      const fresh: SidebarTab = {
        id: mintTabId(),
        type: 'editor',
        title: baseName(absolute),
        path: absolute,
        meta: { treeOpen: false },
      }
      const { node, leafId } = insertLeafAt(state[key], pane.id, 'row', fresh, false)
      return { ...state, [key]: node, activePane: leafId }
    })
  }

  // The viewer's toolbar, hoisted into THIS header: the text editor reports
  // its state and registers its commands (both null/absent for viewers
  // without a toolbar — image, pdf, binary download).
  const [toolbar, setToolbar] = useState<EditorToolbarState | null>(null)
  /** Live mirror of the toolbar (the fs listener reads dirty at event time). */
  const toolbarRef = useRef<EditorToolbarState | null>(null)
  toolbarRef.current = toolbar
  const controlsRef = useRef<EditorToolbarControls | null>(null)
  const onToolbarState = useCallback((next: EditorToolbarState) => {
    // A successful save makes the disk content equal to the buffer again: a
    // pending "changed on disk" notice is stale after that (the write's own
    // events are suppressed host-side, so no new feed burst clears it).
    if (next.saveState === 'saved') setDiskNotice(prev => prev === 'changed' ? 'ok' : prev)
    setToolbar(prev => prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])
  const onToolbarControls = useCallback((controls: EditorToolbarControls | null) => {
    controlsRef.current = controls
  }, [])

  // The docked panel's drag-resize: pointer capture on the handle itself
  // (no window listeners — the captured pointer keeps tracking even off the
  // handle). Local width while dragging, persisted into meta.treeWidth on
  // release. The panel docks right, so dragging LEFT widens it.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const treeWidth = dragWidth ?? treeWidthOf(tab)

  const onResizeStart = (event: React.PointerEvent): void => {
    event.preventDefault()
    // jsdom lacks setPointerCapture — the tests dispatch plain MouseEvents.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { startX: event.clientX, startWidth: treeWidth }
  }
  const onResizeMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    setDragWidth(clampTreeWidth(drag.startWidth + (drag.startX - event.clientX)))
  }
  const onResizeEnd = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    setDragWidth(null)
    const finalWidth = clampTreeWidth(drag.startWidth + (drag.startX - event.clientX))
    if (finalWidth !== treeWidthOf(tab)) patchMeta(ctx, tab, { treeWidth: finalWidth })
  }

  useEffect(() => {
    // A (re)load or a path-less tab clears any hoisted toolbar state — the
    // fresh viewer re-registers its own. A path/session switch also clears a
    // stale disk notice (the new file's state is unknown until its next
    // burst).
    setToolbar(null)
    setDiskNotice('ok')
    // The seeded home tab (no path) never loads a viewer — the empty-state
    // hint renders until the user picks a file.
    if (showEmpty) return
    let cancelled = false
    // Aborts the matched viewer's `load` when the editor tears down (tab
    // closed, path changed, session switched) or re-matches the viewer.
    const controller = new AbortController()
    // A RELOAD of the same path (fs-events burst) keeps the last rendered
    // content on screen while the fresh bytes fetch — no "loading" flash and
    // no unmount of the CodeMirror/preview surface (scroll, undo history and
    // the dirty draft survive the refetch). First load and path switches
    // still go through the plain loading state.
    const silent = reloadTick > 0 && lastReadyRef.current?.path === path
    if (!silent) setLoad({ status: 'loading' })
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          setLoad({ status: 'binary' })
          return
        case 'render':
          lastReadyRef.current = { path }
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope, controller.signal).then((data) => {
            if (cancelled) return
            lastReadyRef.current = { path }
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            // Binary reads carry the head bytes for the detect re-match.
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
            }, (head) => ctx.betterSidebar?.matchFileViewer(path, head), mediaUrlOf)
            apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    apply(planFirstMatch(ctx.betterSidebar?.matchFileViewer(path), mediaUrlOf))
    return () => { cancelled = true; controller.abort() }
    // reloadTick is the fs-events re-fetch trigger; the run resets toolbar and
    // disk notice, so both stay in the cleanup-free effect body above.
  }, [scope.sessionId, scope.cwd, path, ctx, showEmpty, reloadTick])

  // The fs-events subscription for THIS open file: an external change of the
  // exact path auto-reloads when the editor is clean (silent re-fetch); with
  // unsaved edits it arms the "changed on disk" banner instead of dropping
  // the draft; an unlink (file deleted or moved away) arms the deleted
  // banner and never auto-reloads (the read would only fail). The event
  // handler reads the live toolbar through the ref, so subscription can stay
  // keyed on the path alone.
  useFsEvents(scope, (batch) => {
    if (path === '') return
    for (const event of batch.events) {
      if (unlinkCoversPath(event, path)) {
        setDiskNotice('deleted')
        return
      }
      if (changeMatchesPath(event, path)) {
        if (toolbarRef.current?.dirty === true) {
          setDiskNotice('changed')
        } else {
          setDiskNotice('ok')
          setReloadTick(tick => tick + 1)
        }
        return
      }
    }
  })

  const treeOpen = treeOpenOf(tab)
  /** Persist the panel flag on the tab (survives reloads with the layout). */
  const toggleTree = (): void => { patchMeta(ctx, tab, { treeOpen: !treeOpen }) }
  const saveLabel = toolbar === null ? ''
    : toolbar.saveState === 'saving' ? t('loading')
      : toolbar.saveState === 'saved' ? t('saved')
        : toolbar.saveState === 'failed' ? t('saveFailed') : ''

  // Split mode: the path-less window IS the standalone explorer — the tree
  // panel fills the whole tab (search + FileTree, full form), no editor
  // chrome. File opens land in new per-path tabs through openFile above.
  if (treeOnly) {
    return (
      <div className={css.editor}>
        <TreePanel
          full
          sessionId={scope.sessionId}
          cwd={scope.cwd}
          expanded={expanded}
          onToggle={onToggleDir}
          onOpenFile={openFile}
          onOpenFileNewTab={openFileNewTab}
          onOpenFileSide={openFileSide}
          onReferenceFile={onReferenceFile}
        />
      </div>
    )
  }

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <EditorPathInput key={path} path={path} cwd={scope.cwd} onOpen={openFile} />
        {toolbar?.modes === true && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'preview' && css.editorModeActive)}
              onClick={() => { controlsRef.current?.setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'edit' && css.editorModeActive)}
              onClick={() => { controlsRef.current?.setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {toolbar?.dirty === true && <span className={css.dirtyDot} title={t('unsaved')} />}
        {toolbar?.editable === true && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={() => { controlsRef.current?.save() }}
          >
            <IconCheckOutline16 size={14} />
          </button>
        )}
        {saveLabel !== '' && (
          <span className={clsx(css.editorStatus, toolbar?.saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>
        )}
        <button
          type="button"
          className={clsx(css.iconButton, treeOpen && css.editorTreeToggleActive)}
          aria-label={t('editorTreeToggle')}
          title={t('editorTreeToggle')}
          aria-pressed={treeOpen}
          onClick={toggleTree}
        >
          <IconFolderOpen16 size={14} />
        </button>
      </div>
      {diskNotice !== 'ok' && (
        <div className={css.editorDiskBanner} role="status">
          <span>{diskNotice === 'deleted' ? t('fileDeletedOnDisk') : t('fileChangedOnDisk')}</span>
          <button
            type="button"
            className={css.editorDiskBannerButton}
            onClick={() => {
              // Explicit recovery: discard the stale buffer (or retry the
              // deleted file) and re-fetch from disk.
              setDiskNotice('ok')
              setReloadTick(tick => tick + 1)
            }}
          >
            {t('reloadFromDisk')}
          </button>
        </div>
      )}
      <div className={css.editorBody}>
        <div className={css.editorMain}>
          {showEmpty && <div className={css.editorPlaceholder}>{t('editorEmptyHint')}</div>}
          {!showEmpty && load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
          {!showEmpty && load.status === 'error' && <div className={css.editorError}>{load.message}</div>}
          {!showEmpty && load.status === 'binary' && <BinaryDownload scope={scope} path={path} />}
          {!showEmpty && load.status === 'ready' && createElement(load.viewer.component, {
            ctx, store, scope, path, title,
            viewerId: load.viewer.id,
            content: load.content,
            truncated: load.truncated,
            mediaUrl: load.mediaUrl,
            customData: load.customData,
            // The viewer's toolbar always hoists into this host's header.
            toolbar: 'host',
            onToolbarState,
            onToolbarControls,
          })}
        </div>
        {treeOpen && (
          <div className={css.editorTreeDock} style={{ width: treeWidth }}>
            <div
              className={css.editorTreeResize}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('editorTreeToggle')}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
            />
            <TreePanel
              sessionId={scope.sessionId}
              cwd={scope.cwd}
              expanded={expanded}
              onToggle={onToggleDir}
              onOpenFile={openFile}
              onOpenFileNewTab={openFileNewTab}
              onOpenFileSide={openFileSide}
              onReferenceFile={onReferenceFile}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The header's path input: shows the current file relative to the session
 * cwd (absolute when outside it). Enter resolves the typed path (relative
 * input joins onto the cwd — the same resolution `openSidebarFile` uses)
 * and opens it through the parent's mode-aware open (in-place switch or a
 * per-path dedupe tab); Escape/blur restores the current value. The parent
 * keys it by `path` so an in-place switch remounts and reseeds the draft.
 */
function EditorPathInput(props: { path: string; cwd: string | undefined; onOpen: (path: string) => void }) {
  const { path, cwd, onOpen } = props
  const display = path === '' ? '' : relativeTo(cwd ?? '', path)
  const [value, setValue] = useState(display)

  const commit = (): void => {
    const input = value.trim()
    if (input === '' || input === display) {
      setValue(display)
      return
    }
    onOpen(resolveSidebarPath(cwd, input))
    // Split mode: the open lands in a NEW/deduped editor tab — THIS tab's
    // path stays, so the input falls back to its own display value. (Merged
    // mode remounts this input on the new path; the reset is harmless.)
    setValue(display)
  }

  return (
    <input
      className={css.editorPathInput}
      value={value}
      placeholder={t('editorPathPlaceholder')}
      title={path}
      spellCheck={false}
      onChange={(event) => { setValue(event.target.value) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          setValue(display)
        }
      }}
      onBlur={() => { setValue(display) }}
    />
  )
}
