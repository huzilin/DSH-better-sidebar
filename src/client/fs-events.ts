/**
 * Client half of the fs-events feed: a per-session WebSocket subscription to
 * the host's /sidebar/ws/fs-events push (see host fs-watch.ts — debounced
 * chokidar bursts). The tree panel and the editor host subscribe per active
 * session; the module keeps ONE socket per (session, cwd) behind a refcount,
 * so an arbitrary number of consumers share the connection, and the socket
 * tears down with its last consumer (a closed sidebar watches nothing).
 *
 * The reconnect loop mirrors the agent-terminals push: a dropped socket is
 * retried with a short backoff a bounded number of times, then the feed goes
 * silent until the next acquisition (session switch re-attaches). Test
 * environments without a WebSocket keep the feed alive unconnected, and
 * {@link dispatchFsEvents} delivers batches directly — the component logic
 * (tree refresh / editor reload) is exercised without any network.
 *
 * The pure path helpers below decide WHAT an event batch invalidates:
 * - {@link treeVisibleImpact} — whether any listing the tree currently shows
 *   (workspace root + expanded directories) could have changed;
 * - {@link unlinkedExpandedDirs} — expanded dirs destroyed by an unlink (the
 *   Sidebar prunes them so the tree never shows a ghost subtree);
 * - {@link unlinkCoversPath} / {@link changeMatchesPath} — whether a batch
 *   touches the editor's open file (reload, or the deleted-file banner).
 */
import { useEffect, useRef } from 'react'
import type { SessionScope } from './api.ts'
import { normalizeFsPath, parentDirOf } from '../fs-path.ts'

/** One normalized watch event (mirror of the host's wire shape). */
export type FsWatchKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
export interface FsWatchEvent { kind: FsWatchKind; path: string }
/** One debounced burst delivered to subscribers. */
export interface FsEventBatch { id: number; events: readonly FsWatchEvent[] }
type FsListener = (batch: FsEventBatch) => void

const FAILURE_LIMIT = 3
const RETRY_MS = 2000

/** A feed key: the session plus the cwd hint it was attached with (a cwd
 *  change re-attaches so the host watches the right root even before the
 *  session header hydrates). */
function keyOf(sessionId: string, cwd: string | undefined): string {
  return `${sessionId}\u0000${cwd ?? ''}`
}

interface Feed {
  key: string
  sessionId: string
  /** The cwd hint the feed attached with (rides the WS query). */
  cwdHint: string | undefined
  refs: number
  teardown: boolean
  socket: WebSocket | null
  retryTimer: number | undefined
  failures: number
  listeners: Set<FsListener>
  seq: number
}

const feeds = new Map<string, Feed>()

/** The production WebSocket constructor (overridable in tests). */
let wsFactory: ((url: string) => WebSocket) | null = null
/** Test seam: swap the socket constructor (set null to restore default). */
export function setFsTestWsFactory(factory: ((url: string) => WebSocket) | null): void {
  wsFactory = factory
}

function wsUrl(scope: SessionScope): string {
  const url = new URL('/sidebar/ws/fs-events', location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams({ sessionId: scope.sessionId })
  if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
  url.search = params.toString()
  return url.toString()
}

/** Open the socket for a feed (idempotent; silent where WebSocket is absent). */
function connect(feed: Feed): void {
  if (feed.teardown) return
  if (feed.socket !== null && feed.socket.readyState <= 1) return
  if (feed.retryTimer !== undefined) return
  let socket: WebSocket
  try {
    socket = (wsFactory ?? ((url) => new WebSocket(url)))(wsUrl({ sessionId: feed.sessionId, cwd: feed.cwdHint }))
  } catch {
    // No WebSocket implementation (jsdom unit tests): the feed stays live and
    // receives batches through dispatchFsEvents; nothing to reconnect.
    return
  }
  feed.socket = socket
  socket.onmessage = (event) => { dispatchFrame(feed, event.data) }
  socket.onclose = () => {
    feed.socket = null
    if (feed.teardown) return
    feed.failures += 1
    if (feed.failures >= FAILURE_LIMIT) {
      console.error('[dsh-better-sidebar] fs-events connection failed; stopping reconnect loop', feed.sessionId)
      return
    }
    feed.retryTimer = window.setTimeout(() => {
      feed.retryTimer = undefined
      connect(feed)
    }, RETRY_MS)
  }
  socket.onerror = () => { socket.close() }
}

/** Parse one host frame and dispatch it to the feed's listeners. */
function dispatchFrame(feed: Feed, raw: unknown): void {
  if (feed.teardown || typeof raw !== 'string') return
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return }
  if (parsed === null || typeof parsed !== 'object') return
  const frame = parsed as { type?: unknown; events?: unknown }
  if (frame.type !== 'fs' || !Array.isArray(frame.events)) return
  const events: FsWatchEvent[] = []
  for (const item of frame.events) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as { kind?: unknown; path?: unknown }
    if (typeof entry.path !== 'string') continue
    const kind = entry.kind
    if (kind !== 'add' && kind !== 'addDir' && kind !== 'change' && kind !== 'unlink' && kind !== 'unlinkDir') continue
    events.push({ kind, path: entry.path })
  }
  if (events.length === 0) return
  dispatch(feed, events)
}

/** Deliver a batch to a feed's current listeners (socket path + test seam). */
function dispatch(feed: Feed, events: readonly FsWatchEvent[]): void {
  feed.seq += 1
  const batch: FsEventBatch = { id: feed.seq, events }
  for (const listener of [...feed.listeners]) {
    try { listener(batch) } catch (error) {
      console.error('[dsh-better-sidebar] fs-events listener error:', error)
    }
  }
}

/**
 * Test seam: deliver a batch directly to a session's subscribers without a
 * socket. Harmless in production (no feed → no-op); lets the component
 * behavior (tree refresh, editor reload) be tested in isolation.
 */
export function dispatchFsEvents(scope: SessionScope, events: readonly FsWatchEvent[]): void {
  const feed = feeds.get(keyOf(scope.sessionId, scope.cwd))
  if (feed === undefined || feed.teardown) return
  dispatch(feed, events)
}

function acquire(scope: SessionScope): Feed {
  const key = keyOf(scope.sessionId, scope.cwd)
  let feed = feeds.get(key)
  if (feed === undefined) {
    feed = {
      key,
      sessionId: scope.sessionId,
      refs: 0,
      teardown: false,
      socket: null,
      retryTimer: undefined,
      failures: 0,
      listeners: new Set(),
      seq: 0,
      cwdHint: scope.cwd,
    }
    feeds.set(key, feed)
  }
  feed.refs += 1
  connect(feed)
  return feed
}

function release(scope: SessionScope): void {
  const feed = feeds.get(keyOf(scope.sessionId, scope.cwd))
  if (feed === undefined) return
  feed.refs -= 1
  if (feed.refs > 0) return
  feed.teardown = true
  if (feed.retryTimer !== undefined) {
    window.clearTimeout(feed.retryTimer)
    feed.retryTimer = undefined
  }
  const socket = feed.socket
  feed.socket = null
  try { socket?.close() } catch { /* already closed or never opened */ }
  feed.listeners.clear()
  feeds.delete(feed.key)
}

/**
 * Subscribe a component to the fs-events feed of a session. The handler is
 * called with every debounced burst; it always sees the LATEST render's
 * closure (the hook keeps it in a ref), so consumers may capture fresh
 * props/state (cwd, expanded dirs, dirty flag) without re-subscribing.
 */
export function useFsEvents(scope: SessionScope | undefined, listener: FsListener): void {
  const listenerRef = useRef(listener)
  listenerRef.current = listener
  useEffect(() => {
    if (scope === undefined || scope.sessionId === '') return
    const feed = acquire(scope)
    const dispatcher: FsListener = (batch) => { listenerRef.current(batch) }
    feed.listeners.add(dispatcher)
    return () => {
      feed.listeners.delete(dispatcher)
      release(scope)
    }
    // A session or cwd change re-attaches the feed (the host watches the new
    // workspace root). The listener itself rides the ref — never a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.sessionId, scope?.cwd])
}

// ── Pure invalidation helpers ────────────────────────────────────────────

/**
 * Whether a batch could change what the tree's VISIBLE listings show (the
 * workspace root + every expanded directory). An event invalidates a listing
 * when the event's PARENT is a visible dir (a row inside it appeared,
 * disappeared, or changed) — or when the event IS a visible dir (the dir
 * itself was unlinked/renamed). Events outside the visible set (deep writes
 * in unexpanded subtrees) leave the tree untouched.
 */
export function treeVisibleImpact(
  events: readonly FsWatchEvent[],
  root: string | undefined,
  expanded: readonly string[],
): boolean {
  if (root === undefined || root === '' || events.length === 0) return false
  const visible = new Set<string>([normalizeFsPath(root)])
  for (const dir of expanded) visible.add(normalizeFsPath(dir))
  return events.some((event) => {
    const path = normalizeFsPath(event.path)
    if (visible.has(path)) return true
    const parent = parentDirOf(path)
    return visible.has(parent)
  })
}

/**
 * The expanded dirs a batch's unlink events destroy: the dir itself, or an
 * expanded dir nested under a removed directory. The Sidebar prunes these so
 * the tree cannot keep auto-expanding a ghost subtree (a rename shows the
 * collapsed dir at its new path, exactly like a manual refresh would).
 */
export function unlinkedExpandedDirs(
  events: readonly FsWatchEvent[],
  expanded: readonly string[],
): string[] {
  const removed = events
    .filter(event => event.kind === 'unlink' || event.kind === 'unlinkDir')
    .map(event => normalizeFsPath(event.path))
  if (removed.length === 0 || expanded.length === 0) return []
  return expanded.filter((dir) => {
    const candidate = normalizeFsPath(dir)
    return removed.some(removedPath =>
      candidate === removedPath || candidate.startsWith(`${removedPath}/`))
  })
}

/** Whether an unlink/unlinkDir event removes `path` (same file, or the file
 *  sits under a removed directory). */
export function unlinkCoversPath(event: FsWatchEvent, path: string): boolean {
  if (event.kind !== 'unlink' && event.kind !== 'unlinkDir') return false
  const removed = normalizeFsPath(event.path)
  const target = normalizeFsPath(path)
  return target === removed || target.startsWith(`${removed}/`)
}

/** Whether a change event touches `path` exactly (the editor's open file). */
export function changeMatchesPath(event: FsWatchEvent, path: string): boolean {
  return event.kind === 'change' && normalizeFsPath(event.path) === normalizeFsPath(path)
}

/** Re-export for host/cwd comparisons in client code. */
export { normalizeFsPath }