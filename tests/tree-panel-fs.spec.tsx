/**
 * TreePanel × fs-events: the explorer auto-refreshes when a burst touches a
 * listing it currently shows — a file created/removed/moved under the
 * workspace root or an expanded directory — and stays quiet for events in
 * unexpanded subtrees (no pointless re-listing). The host socket is stubbed;
 * batches are delivered through dispatchFsEvents.
 */
// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { dispatchFsEvents, setFsTestWsFactory } from '../src/client/fs-events.ts'
import { TreePanel } from '../src/client/TreePanel.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { treeCalls } = vi.hoisted(() => ({ treeCalls: [] as string[] }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async (_scope: unknown, dir: string) => {
      treeCalls.push(dir)
      // Dir-aware listing: expanding /tmp/src must NOT recurse into itself.
      const entries = dir === '/tmp/src'
        ? [{ name: 'old.ts', path: '/tmp/src/old.ts', isDir: false, isSymlink: false, broken: false, hidden: false }]
        : [
          { name: 'src', path: '/tmp/src', isDir: true, isSymlink: false, broken: false, hidden: false },
          { name: 'a.ts', path: '/tmp/a.ts', isDir: false, isSymlink: false, broken: false, hidden: false },
        ]
      return { path: dir, truncated: false, entries }
    },
    fsSearch: async () => ({ matches: [], truncated: false }),
  },
  mediaUrl: (): string => '/sidebar/file',
  downloadUrl: (): string => '/sidebar/file',
  htmlUrl: (): string => '/sidebar/html',
}))

beforeAll(() => {
  setFsTestWsFactory(() => ({
    OPEN: 1, readyState: 1,
    close: () => {},
  } as unknown as WebSocket))
})
afterAll(() => { setFsTestWsFactory(null) })
beforeEach(() => { treeCalls.length = 0 })

const SCOPE = { sessionId: 'tree-session', cwd: '/tmp' }

interface Harness {
  container: HTMLDivElement
  rerender: (expanded: string[]) => void
  unmount: () => void
}

async function mountTree(expanded: string[]): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (nextExpanded: string[]): void => {
    root.render(createElement(TreePanel, {
      sessionId: SCOPE.sessionId,
      cwd: SCOPE.cwd,
      expanded: nextExpanded,
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      onReferenceFile: () => {},
    }))
  }
  await act(async () => { render(expanded) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return {
    container,
    rerender: async (next: string[]) => {
      await act(async () => { render(next) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Deliver one fs burst (inside act so React flushes the refresh). */
async function burst(...events: Array<{ kind: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string }>): Promise<void> {
  await act(async () => { dispatchFsEvents(SCOPE, events) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('TreePanel × fs-events', () => {
  it('re-lists the workspace root when a burst touches it', async () => {
    const { container, unmount } = await mountTree([])
    try {
      expect(treeCalls).toEqual(['/tmp'])
      await burst({ kind: 'add', path: '/tmp/new.ts' })
      expect(treeCalls).toEqual(['/tmp', '/tmp'])
    } finally { unmount() }
  })

  it('re-lists an expanded directory when a burst lands inside it', async () => {
    const { container, rerender, unmount } = await mountTree([])
    try {
      expect(treeCalls).toEqual(['/tmp'])
      await rerender(['/tmp/src'])
      // Root stays cached; only the newly expanded level is fetched.
      expect(treeCalls).toEqual(['/tmp', '/tmp/src'])
      await burst({ kind: 'unlink', path: '/tmp/src/old.ts' })
      // The visible set re-lists after the cache wipe (root + expanded).
      expect(treeCalls).toEqual(['/tmp', '/tmp/src', '/tmp', '/tmp/src'])
    } finally { unmount() }
  })

  it('stays quiet for events in unexpanded subtrees', async () => {
    const { container, unmount } = await mountTree([])
    try {
      expect(treeCalls).toEqual(['/tmp'])
      await burst({ kind: 'change', path: '/tmp/node_modules/x/deep.ts' })
      expect(treeCalls).toEqual(['/tmp'])
    } finally { unmount() }
  })

  it('one burst of several visible events produces one refresh (host coalesces)', async () => {
    const { container, unmount } = await mountTree(['/tmp/src'])
    try {
      const before = treeCalls.length
      await burst(
        { kind: 'add', path: '/tmp/s1.ts' },
        { kind: 'unlink', path: '/tmp/s2.ts' },
        { kind: 'change', path: '/tmp/src/a.ts' },
      )
      // Root + expanded dir each re-listed once (two calls, not three).
      const extra = treeCalls.slice(before)
      expect(extra.filter(p => p === '/tmp')).toHaveLength(1)
      expect(extra.filter(p => p === '/tmp/src')).toHaveLength(1)
    } finally { unmount() }
  })
})