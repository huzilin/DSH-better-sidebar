/**
 * EditorHost × fs-events: the open file's tab reacts to the session's
 * filesystem feed — a clean editor AUTO-RELOADS on a change burst (with the
 * old content kept on screen until the fresh bytes land), an editor with
 * unsaved edits arms the "changed on disk" banner instead of dropping the
 * draft (the banner's reload knowingly discards it), and an unlink arms the
 * deleted banner until the file comes back. The host socket is stubbed (the
 * feed stays live unconnected); batches are delivered through
 * dispatchFsEvents, so no network or chokidar is involved.
 */
// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import type { SessionScope } from '../src/client/api.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { dispatchFsEvents, setFsTestWsFactory } from '../src/client/fs-events.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** The file content the mocked fsRead will return next, per successful call. */
const { readQueue } = vi.hoisted(() => ({ readQueue: [] as string[] }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsRead: async () => ({
      kind: 'text' as const,
      content: readQueue.shift() ?? '<empty>',
      truncated: false,
    }),
    fsWrite: async () => ({ ok: true }),
  },
  mediaUrl: (): string => '/sidebar/file',
  downloadUrl: (): string => '/sidebar/file',
  htmlUrl: (): string => '/sidebar/html',
}))

beforeAll(() => {
  // The feed never touches the network in tests: a stub socket keeps the
  // feed "connected" while dispatchFsEvents delivers the batches directly.
  setFsTestWsFactory(() => ({
    OPEN: 1, readyState: 1,
    close: () => {},
  } as unknown as WebSocket))
})
afterAll(() => { setFsTestWsFactory(null) })
beforeEach(() => { readQueue.length = 0 })

const SCOPE: SessionScope = { sessionId: 'fs-session', cwd: '/tmp' }

/** A hoisted module-level viewer (a component defined inside another render
 *  would be a NEW type per render — React would remount it and drop the
 *  dirty state). Renders the content and reports a self-dirtying toolbar. */
function Viewer(props: {
  content?: string
  onToolbarState?: (state: { modes: boolean; mode: string; dirty: boolean; editable: boolean; saveState: string }) => void
}): ReactNode {
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    props.onToolbarState?.({ modes: false, mode: 'preview', dirty, editable: false, saveState: 'idle' })
  }, [dirty])
  return (
    <div className="viewer-content">
      <span className="viewer-text">{props.content ?? ''}</span>
      <button type="button" className="make-dirty" onClick={() => { setDirty(true) }}>make-dirty</button>
    </div>
  )
}

/** A store + registry with a plain fsRead viewer for .ts (renders content in
 *  a div and reports a self-dirtying toolbar — the TextEditor contract). */
function setup(): {
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  tab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'test:code',
    title: 'Code',
    exts: ['ts'],
    fetchStrategy: 'fsRead',
    component: Viewer as never,
  })
  store.setSession(SCOPE.sessionId)
  service.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
  const tab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      .find(candidate => candidate.path === '/tmp/a.ts')!
  const sessionsSnapshot = { byId: { [SCOPE.sessionId]: { cwd: '/tmp' } }, current: SCOPE.sessionId }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { ctx, store, tab }
}

/** Mount the host for the file tab; returns container + unmount. */
async function mount(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): Promise<{
  container: HTMLDivElement
  unmount: () => void
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (): void => {
    root.render(createElement(EditorHost, {
      ctx, store, scope: SCOPE,
      tab: tab(),
      expanded: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  }
  await act(async () => { render() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Deliver one fs burst to the session feed (inside act so React flushes). */
async function burst(...events: Array<{ kind: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string }>): Promise<void> {
  await act(async () => { dispatchFsEvents(SCOPE, events) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function viewerText(container: HTMLDivElement): string {
  return container.querySelector('.viewer-text')?.textContent ?? ''
}

describe('EditorHost × fs-events', () => {
  it('a clean editor AUTO-RELOADS when the open file changes on disk', async () => {
    readQueue.push('v1', 'v2')
    const { ctx, store, tab } = setup()
    const { container, unmount } = await mount(ctx, store, tab)
    try {
      expect(viewerText(container)).toBe('v1')
      await burst({ kind: 'change', path: '/tmp/a.ts' })
      expect(viewerText(container)).toBe('v2')
    } finally { unmount() }
  })

  it('changes to OTHER files leave the open editor untouched', async () => {
    readQueue.push('v1', 'v2')
    const { ctx, store, tab } = setup()
    const { container, unmount } = await mount(ctx, store, tab)
    try {
      expect(viewerText(container)).toBe('v1')
      await burst({ kind: 'change', path: '/tmp/other.ts' })
      expect(viewerText(container)).toBe('v1')
      expect(readQueue).toHaveLength(1) // 'v2' not consumed: no reload happened
    } finally { unmount() }
  })

  it('with unsaved edits a change arms the banner instead of dropping the draft', async () => {
    readQueue.push('v1', 'v2')
    const { ctx, store, tab } = setup()
    const { container, unmount } = await mount(ctx, store, tab)
    try {
      expect(viewerText(container)).toBe('v1')
      // Dirty the editor (reports dirty through the hoisted toolbar).
      act(() => { container.querySelector<HTMLButtonElement>('.make-dirty')!.click() })
      await burst({ kind: 'change', path: '/tmp/a.ts' })
      // Content stays; the banner offers the explicit reload.
      expect(viewerText(container)).toBe('v1')
      expect(container.textContent).toContain('File changed on disk')
      const reload = [...container.querySelectorAll('button')]
        .find(button => button.textContent?.includes('Reload from disk'))!
      expect(reload).toBeDefined()
      // The explicit reload knowingly discards the draft and re-fetches.
      act(() => { reload.click() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(viewerText(container)).toBe('v2')
      expect(container.textContent).not.toContain('File changed on disk')
    } finally { unmount() }
  })

  it('an unlink of the open file arms the deleted banner; a later re-create reloads it', async () => {
    readQueue.push('v1', 'v2')
    const { ctx, store, tab } = setup()
    const { container, unmount } = await mount(ctx, store, tab)
    try {
      expect(viewerText(container)).toBe('v1')
      await burst({ kind: 'unlink', path: '/tmp/a.ts' })
      expect(viewerText(container)).toBe('v1')
      expect(container.textContent).toContain('File deleted from disk')
      // The file comes back (agent recreated it): clean auto-reload.
      await burst({ kind: 'change', path: '/tmp/a.ts' })
      expect(viewerText(container)).toBe('v2')
      expect(container.textContent).not.toContain('File deleted from disk')
    } finally { unmount() }
  })

  it('an unlink of a PARENT directory also covers the open file (delete banner)', async () => {
    readQueue.push('v1', 'v2')
    const { ctx, store, tab } = setup()
    const { container, unmount } = await mount(ctx, store, tab)
    try {
      expect(viewerText(container)).toBe('v1')
      await burst({ kind: 'unlinkDir', path: '/tmp' })
      expect(container.textContent).toContain('File deleted from disk')
    } finally { unmount() }
  })
})