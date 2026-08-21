/**
 * Host-side filesystem watching for the sidebar: one chokidar watcher per
 * session (rooted at the session's working directory), broadcasting change
 * events to the connected sidebar views over the /sidebar/ws/fs-events
 * WebSocket. This is what keeps the explorer tree and the open editor honest
 * when files change OUTSIDE the sidebar itself — an agent edit, a git
 * checkout, an external editor — not just after this plugin's own write.
 *
 * The wire frame is one JSON message per debounced burst:
 *
 *   { "type": "fs", "events": [ { "kind": "change", "path": "/abs/path" }, ... ] }
 *
 * `kind` mirrors chokidar's normalized event names (`add` / `addDir` /
 * `change` / `unlink` / `unlinkDir`). The client dispatches the burst to the
 * tree (re-list the visible directories) and the editor (reload the open
 * file) without knowing anything about the watcher.
 *
 * Lifecycle: a watcher exists only while at least one sidebar socket for the
 * session is attached (refcounted by socket); the last detach closes it, so
 * an idle sidebar never holds directory watchers. Events are coalesced into
 * bursts with a fixed debounce (trailing window) and a max-hold cap, so a
 * continuous write stream (a build, a long agent turn) still flushes
 * periodically instead of stalling forever.
 *
 * Self-write suppression: the sidebar's OWN saves (fs.write route) write a
 * temp sibling and rename it into place; without suppression those events
 * would bounce straight back into the editor as a spurious reload. The host
 * records recently-written paths and the hub drops matching events for a
 * short window (uploads deliberately do NOT suppress — their events drive the
 * very tree refresh the upload flow already triggers).
 */
import chokidar, { type FSWatcher } from 'chokidar'
import { normalizeFsPath } from './fs-path.ts'

/** One normalized watch event (mirror of chokidar's 'all' event names). */
export type FsWatchKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
export interface FsWatchEvent { kind: FsWatchKind; path: string }
export interface FsWatchFrame { type: 'fs'; events: FsWatchEvent[] }

/**
 * The socket surface the hub needs (real `ws` WebSockets qualify
 * structurally; tests may pass lighter fakes). Only the readyState/OPEN
 * broadcast guard and send are used — the socket lifecycle stays with the
 * route handler that owns the upgrade.
 */
export interface FsWatchSocket {
  readyState: number
  OPEN: number
  send(payload: string): void
}

/** Paths nested under a `.git` directory are never watched (chokidar prunes
 *  them; the explorer's hidden rows also dim them). One directory check per
 *  path segment, separator-tolerant — chokidar always reports platform paths.
 */
function isInsideGitDir(path: string): boolean {
  return path.split(/[\\/]/).some(segment => segment === '.git')
}

/** The sidebar's own temp-write files (`<target>.dsh-sidebar-tmp-<pid>`)
 *  exist only between the write and the rename; their events carry no
 *  information and only churn the debounce queue. */
function isSidebarTemp(path: string): boolean {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return base.includes('.dsh-sidebar-tmp-')
}

/** Trailing debounce window per burst (restarts on every event). */
const FLUSH_DEBOUNCE_MS = 150
/** Max-hold cap: a continuous event stream flushes at least this often. */
const FLUSH_MAX_HOLD_MS = 400
/** How long a self-write stays suppressed after its own save (chokidar may
 *  deliver the change event tens of milliseconds late). */
const OWN_WRITE_SUPPRESS_MS = 500

/** One active session watch. */
interface SessionWatch {
  sessionId: string
  /** The absolute workspace root the watcher follows (restart on change). */
  cwd: string
  watcher: FSWatcher | null
  /** Connected sidebar view sockets (the broadcast fan-out). */
  sockets: Set<FsWatchSocket>
  /** Coalesced events pending the debounce flush (keyed by path: the LAST
   *  kind wins — an unlink after a change must read as unlink). */
  pending: Map<string, FsWatchEvent>
  flushTimer: NodeJS.Timeout | null
  firstQueuedAt: number
  /** Absolute paths written by this plugin's own save route, with timestamps
   *  (entries older than OWN_WRITE_SUPPRESS_MS are dropped on arrival). */
  ownWrites: Map<string, number>
}

/**
 * Session-keyed watcher registry. Callers attach/detach WebSockets; the hub
 * owns the chokidar lifecycle, the debounce/coalesce queue per session, and
 * the broadcast. No global state — one hub is created per plugin activation.
 */
export class FsWatchHub {
  private readonly sessions = new Map<string, SessionWatch>()

  /** Watch state for a session (creating it on first attach). */
  private ensure(sessionId: string, cwd: string): SessionWatch {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const watch: SessionWatch = {
      sessionId,
      cwd,
      watcher: null,
      sockets: new Set(),
      pending: new Map(),
      flushTimer: null,
      firstQueuedAt: 0,
      ownWrites: new Map(),
    }
    this.sessions.set(sessionId, watch)
    this.openWatcher(watch)
    return watch
  }

  /** Start the chokidar watcher for one session (ignoreInitial: the initial
   *  scan is not a change — the tree already rendered fresh on connect). */
  private openWatcher(watch: SessionWatch): void {
    try {
      const watcher = chokidar.watch(watch.cwd, {
        ignoreInitial: true,
        ignored: (path: string): boolean => isInsideGitDir(path) || isSidebarTemp(path),
      })
      watcher.on('all', (event, path) => { this.onEvent(watch, event, path) })
      watcher.on('error', (error) => {
        // A watcher failure must never take the plugin down: log and keep the
        // sockets alive (they simply stop receiving bursts until a re-attach).
        console.error('[dsh-better-sidebar] fs watcher error:', error)
      })
      watch.watcher = watcher
    } catch (error) {
      console.error('[dsh-better-sidebar] fs watcher failed to start:', error)
    }
  }

  /** Replace the watcher when a session's working directory moved. */
  private reopen(watch: SessionWatch, cwd: string): void {
    if (watch.cwd === cwd) return
    watch.cwd = cwd
    watch.pending.clear()
    const old = watch.watcher
    watch.watcher = null
    void old?.close().catch(() => {})
    this.openWatcher(watch)
  }

  /** Route one chokidar event into the session's coalescing queue. */
  private onEvent(watch: SessionWatch, event: string, rawPath: string): void {
    if (event !== 'add' && event !== 'addDir' && event !== 'change' && event !== 'unlink' && event !== 'unlinkDir') return
    const now = Date.now()
    // Self-write suppression window is time-based: prune silently, drop fresh.
    for (const [path, at] of watch.ownWrites) {
      if (now - at > OWN_WRITE_SUPPRESS_MS) watch.ownWrites.delete(path)
    }
    if (watch.ownWrites.has(rawPath)) return
    watch.pending.set(rawPath, { kind: event, path: rawPath })
    if (watch.firstQueuedAt === 0) watch.firstQueuedAt = now
    if (watch.flushTimer === null) {
      watch.flushTimer = setTimeout(() => { this.flush(watch.sessionId) }, FLUSH_DEBOUNCE_MS)
    } else if (now - watch.firstQueuedAt >= FLUSH_MAX_HOLD_MS) {
      clearTimeout(watch.flushTimer)
      watch.flushTimer = null
      this.flush(watch.sessionId)
    }
  }

  /** Flush one session's pending events to its connected sockets. */
  private flush(sessionId: string): void {
    const watch = this.sessions.get(sessionId)
    if (watch === undefined) return
    if (watch.flushTimer !== null) {
      clearTimeout(watch.flushTimer)
      watch.flushTimer = null
    }
    const events = [...watch.pending.values()]
    watch.pending.clear()
    watch.firstQueuedAt = 0
    if (events.length === 0) return
    const frame: FsWatchFrame = { type: 'fs', events }
    const payload = JSON.stringify(frame)
    for (const socket of watch.sockets) {
      if (socket.readyState === socket.OPEN) {
        try { socket.send(payload) } catch { /* a dead socket: the close
          handler detaches it on the next event loop turn */ }
      }
    }
  }

  /**
   * Attach a sidebar view socket to a session's watch (creating it on first
   * attach). `cwd` is the session's authoritative working directory; a
   * session whose workspace moved gets its watcher restarted.
   */
  attach(sessionId: string, cwd: string, socket: FsWatchSocket): void {
    const watch = this.ensure(sessionId, cwd)
    this.reopen(watch, cwd)
    watch.sockets.add(socket)
  }

  /** Detach a socket; the session's watcher closes when it was the last one. */
  detach(socket: FsWatchSocket): void {
    for (const [sessionId, watch] of this.sessions) {
      if (!watch.sockets.delete(socket)) continue
      if (watch.sockets.size === 0) this.close(sessionId)
      return
    }
  }

  /** Close one session's watch entirely (last socket gone). */
  private close(sessionId: string): void {
    const watch = this.sessions.get(sessionId)
    if (watch === undefined) return
    this.sessions.delete(sessionId)
    if (watch.flushTimer !== null) clearTimeout(watch.flushTimer)
    const watcher = watch.watcher
    watch.watcher = null
    void watcher?.close().catch(() => {})
  }

  /**
   * Record a path this plugin just wrote itself (fs.write route). Its
   * resulting events are suppressed for the suppression window so a save
   * never bounces into a spurious editor reload or tree refresh.
   */
  noteOwnWrite(sessionId: string, path: string): void {
    const watch = this.sessions.get(sessionId)
    if (watch === undefined) return
    watch.ownWrites.set(normalizeFsPath(path), Date.now())
  }

  /** Close every session watcher (plugin teardown). */
  stopAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId)
  }
}

/** Re-export for host callers that resolve event coverage against paths. */
export { normalizeFsPath }