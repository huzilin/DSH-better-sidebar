/**
 * FsWatchHub unit tests (node env): session-keyed chokidar wiring, the
 * debounce/coalesce queue, the broadcast fan-out, and the self-write
 * suppression. chokidar is the nondeterministic OS boundary — a fake
 * watcher stands in for it (same discipline as DSH's settings-file
 * watcher spec), so the hub's own logic is pinned without touching disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsWatchEvent } from '../src/fs-watch.ts'
import { FsWatchHub } from '../src/fs-watch.ts'

/** Fake chokidar watcher (records watch() calls; tests drive events via emit). */
class FakeWatcher {
  static instances: FakeWatcher[] = []
  path: string
  options: Record<string, unknown>
  closed = false
  private handlers = new Map<string, (...args: unknown[]) => void>()
  constructor(path: string, options: Record<string, unknown>) {
    this.path = path
    this.options = options
    FakeWatcher.instances.push(this)
  }
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, handler)
    return this
  }
  async close(): Promise<void> { this.closed = true }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.call(this, ...args)
  }
}

vi.mock('chokidar', () => ({
  default: {
    watch: (path: string, options: Record<string, unknown>) =>
      new FakeWatcher(path, options),
  },
}))

/** Fake sidebar socket: tracks sent frames; OPEN is the constant ws uses. */
class FakeSocket {
  static sentAll: string[][] = []
  OPEN = 1
  readyState = 1
  sent: string[] = []
  sentFrames: FsWatchEvent[][] = []
  constructor() { FakeSocket.sentAll.push(this.sent) }
  send(payload: string): void {
    this.sent.push(payload)
    const parsed = JSON.parse(payload) as { type?: string; events?: FsWatchEvent[] }
    if (parsed.type === 'fs' && Array.isArray(parsed.events)) {
      this.sentFrames.push(parsed.events)
    }
  }
  close(): void { this.readyState = 3 }
}

/** Flush whatever debounce timer the hub armed. */
function flushDebounce(): void {
  vi.advanceTimersByTime(200)
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWatcher.instances = []
  FakeSocket.sentAll = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('FsWatchHub', () => {
  it('attach starts one chokidar watcher at the session cwd with ignoreInitial and the ignore matcher', () => {
    const hub = new FsWatchHub()
    const socket = new FakeSocket()
    hub.attach('s1', '/work', socket)
    expect(FakeWatcher.instances).toHaveLength(1)
    const watcher = FakeWatcher.instances[0]!
    expect(watcher.path).toBe('/work')
    expect(watcher.options.ignoreInitial).toBe(true)
    const ignored = watcher.options.ignored as (path: string) => boolean
    expect(ignored('/work/.git/config')).toBe(true)
    expect(ignored('/work/src/.git/HEAD')).toBe(true)
    expect(ignored('/work/src/a.ts')).toBe(false)
    expect(ignored('/work/a.ts.dsh-sidebar-tmp-12345')).toBe(true)
    hub.stopAll()
  })

  it('coalesces a burst into one frame after the debounce and dedupes by path (last kind wins)', () => {
    const hub = new FsWatchHub()
    const socket = new FakeSocket()
    hub.attach('s1', '/work', socket)
    const watcher = FakeWatcher.instances[0]!
    watcher.emit('all', 'change', '/work/a.ts')
    watcher.emit('all', 'change', '/work/b.ts')
    // The same path changed again within the burst: the last kind wins.
    watcher.emit('all', 'unlink', '/work/a.ts')
    expect(socket.sentFrames).toHaveLength(0)
    flushDebounce()
    expect(socket.sentFrames).toHaveLength(1)
    const frame = socket.sentFrames[0]!
    expect(frame.map(e => e.path).sort()).toEqual(['/work/a.ts', '/work/b.ts'])
    expect(frame.find(e => e.path === '/work/a.ts')?.kind).toBe('unlink')
    expect(frame.find(e => e.path === '/work/b.ts')?.kind).toBe('change')
    hub.stopAll()
  })

  it('a continuous event stream flushes by the max-hold cap instead of stalling', () => {
    const hub = new FsWatchHub()
    const socket = new FakeSocket()
    hub.attach('s1', '/work', socket)
    const watcher = FakeWatcher.instances[0]!
    for (let i = 0; i < 10; i += 1) {
      watcher.emit('all', 'change', `/work/f${i}.ts`)
      vi.advanceTimersByTime(100) // faster than the 150ms debounce restarts
    }
    // The final flush lands by 400ms of continuous activity.
    flushDebounce()
    const total = socket.sentFrames.flat().length
    expect(total).toBe(10)
    expect(socket.sentFrames.length).toBeGreaterThan(1)
    hub.stopAll()
  })

  it('broadcasts only to OPEN sockets', () => {
    const hub = new FsWatchHub()
    const open = new FakeSocket()
    const closed = new FakeSocket()
    closed.readyState = 3 // CLOSED
    hub.attach('s1', '/work', open)
    hub.attach('s1', '/work', closed)
    const watcher = FakeWatcher.instances[0]!
    watcher.emit('all', 'change', '/work/a.ts')
    flushDebounce()
    expect(open.sentFrames).toHaveLength(1)
    expect(closed.sentFrames).toHaveLength(0)
    hub.stopAll()
  })

  it('detaching the last socket closes the watcher; re-attach opens a fresh one', () => {
    const hub = new FsWatchHub()
    const a = new FakeSocket()
    const b = new FakeSocket()
    hub.attach('s1', '/work', a)
    hub.attach('s1', '/work', b)
    expect(FakeWatcher.instances).toHaveLength(1)
    hub.detach(a)
    expect(FakeWatcher.instances[0]!.closed).toBe(false) // b still attached
    hub.detach(b)
    expect(FakeWatcher.instances[0]!.closed).toBe(true)
    // Re-attach (session switch back): a new watcher opens.
    hub.attach('s1', '/work', new FakeSocket())
    expect(FakeWatcher.instances).toHaveLength(2)
    expect(FakeWatcher.instances[1]!.closed).toBe(false)
    hub.stopAll()
  })

  it('an attach with a different cwd reopens the watcher on the new root', () => {
    const hub = new FsWatchHub()
    const socket = new FakeSocket()
    hub.attach('s1', '/work', socket)
    hub.attach('s1', '/new-root', socket)
    expect(FakeWatcher.instances).toHaveLength(2)
    expect(FakeWatcher.instances[0]!.closed).toBe(true)
    expect(FakeWatcher.instances[1]!.path).toBe('/new-root')
    hub.stopAll()
  })

  it('noteOwnWrite suppresses matching events within the window, then lets them through', () => {
    const hub = new FsWatchHub()
    const socket = new FakeSocket()
    hub.attach('s1', '/work', socket)
    const watcher = FakeWatcher.instances[0]!
    hub.noteOwnWrite('s1', '/work/a.ts')
    watcher.emit('all', 'change', '/work/a.ts')
    flushDebounce()
    expect(socket.sentFrames).toHaveLength(0)
    // After the suppression window the same event flows normally.
    vi.advanceTimersByTime(600)
    watcher.emit('all', 'change', '/work/a.ts')
    flushDebounce()
    expect(socket.sentFrames).toHaveLength(1)
    hub.stopAll()
  })

  it('noteOwnWrite before any attach is a safe no-op (the watch is per attach)', () => {
    const hub = new FsWatchHub()
    // No session watch exists yet; the write must not throw nor create one.
    hub.noteOwnWrite('ghost', '/work/a.ts')
    hub.stopAll()
  })

  it('stopAll closes every active watcher and stops all timers', () => {
    const hub = new FsWatchHub()
    hub.attach('s1', '/work', new FakeSocket())
    hub.attach('s2', '/other', new FakeSocket())
    expect(FakeWatcher.instances).toHaveLength(2)
    hub.stopAll()
    expect(FakeWatcher.instances.every(w => w.closed)).toBe(true)
  })
})