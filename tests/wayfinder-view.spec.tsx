/**
 * WayfinderView tests: two view modes.
 *
 * **Iframe mode** (http URL): probes the serve port on mount; when the server
 * is down shows the start command with copy + retry; when it answers, an
 * iframe mounts. Verified with globalThis.fetch stubbed.
 *
 * **List mode** (local path — the .plan/ directory): reads map.md + tickets/
 * via the sidebar fs.read API, derives ticket status per the TRACKER-MARKDOWN
 * contract, and renders a plain grouped list. Verified with api module mocked.
 *
 * Static content is covered with renderToString (effects do not run, so the
 * probing state renders); the interactive paths run under jsdom with mocks.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { WayfinderView, WAYFINDER_DEFAULT_URL, WAYFINDER_START_COMMAND } from '../src/client/WayfinderView.tsx'
import type { TabComponentProps } from '../src/client/service.ts'
import type { FsTextResult } from '../src/client/api.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ─── api mock for list mode tests ────────────────────────────────────────────

const MAP_RAW = `# Demo Map

## Destination

docs-tmp 推演定稿 → arch_design 合并。

## Notes

领域：团队项目工作台。

## Decisions so far

## Not yet specified

- **技能复用评估**：T01 结论出来后可能毕业为新票

## Out of scope

- DSH 平台自身
`

const TICKETS: Record<string, string> = {
  '01-skill-reuse.md': `---
type: research
blocked_by: []
---

# T01 · mattpocock/skills 复用评估

## Question

哪些技能可以从本项目复用？

## Answer

可通过 writing-for-agents 和 wayfinder 复用。
`,
  '02-cd-duty.md': `---
type: research
blocked_by: [01]
claimed_by: session-abc
claimed_at: 2026-08-27T01:00:00Z
---

# T02 · 定时兜底扫描载体选型

## Question

DSH 侧定时机制用什么承载？
`,
  '03-my-task.md': `---
type: grilling
blocked_by: []
---

# T03 · wb_my_task currentTrigger 计算逻辑定稿

## Question

trigger 判定逻辑落到哪一层？
`,
  '04-out.md': `---
type: task
blocked_by: []
---

# T04 · 被排除的票

## Question

为什么排除？

## Ruled out

不在本地图终点内。
`,
}

function makeFsText(content: string): FsTextResult {
  return { kind: 'text', content, truncated: false }
}

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async (_scope: unknown, path: string) => {
      if (path.endsWith('/tickets')) {
        return {
          entries: Object.keys(TICKETS).map(name => ({
            name,
            path: `${path}/${name}`,
            isDir: false,
            hidden: false,
            isSymlink: false,
            broken: false,
          })),
        }
      }
      return { entries: [] }
    },
    fsRead: async (_scope: unknown, path: string) => {
      if (path.endsWith('/map.md')) return makeFsText(MAP_RAW)
      const name = path.split('/').pop() ?? ''
      if (TICKETS[name] !== undefined) return makeFsText(TICKETS[name])
      return { kind: 'binary' as const, size: 0, truncated: false, head: '' }
    },
  },
  writeClipboard: async () => true,
}))

function props(overrides: Partial<TabComponentProps> = {}): TabComponentProps {
  return {
    ctx: undefined as never,
    store: undefined as never,
    scope: { sessionId: 's1' },
    tab: { id: 'wayfinder', type: 'wayfinder', title: 'Wayfinder Map' },
    visible: true,
    ...overrides,
  }
}

// ─── iframe mode tests (unchanged) ──────────────────────────────────────────

describe('WayfinderView (iframe mode)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('renders the probing state while effects have not run (SSR)', () => {
    const html = renderToString(createElement(WayfinderView, props()))
    expect(html).toContain('Checking the Wayfinder server…')
  })

  it('shows the start command with copy + retry when the server is down', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(WayfinderView, props())) })
    await act(async () => { /* flush the probe */ })
    expect(container.textContent).toContain('Wayfinder server is not running')
    expect(container.textContent).toContain(WAYFINDER_START_COMMAND)
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[]
    expect(buttons.some(b => b.textContent === 'Copy start command')).toBe(true)
    expect(buttons.some(b => b.textContent?.includes('Retry'))).toBe(true)
    expect(container.querySelector('iframe')).toBeNull()
    act(() => { root.unmount() })
    container.remove()
  })

  it('copy writes the start command and flashes "Copied"', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(WayfinderView, props())) })
    await act(async () => { /* flush the probe */ })
    const copyButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Copy start command')
    expect(copyButton).toBeDefined()
    await act(async () => { copyButton!.click() })
    expect(primitives.writeClipboard).toHaveBeenCalledWith(WAYFINDER_START_COMMAND)
    expect(copyButton!.textContent).toBe('Copied')
    act(() => { root.unmount() })
    container.remove()
  })

  it('mounts the iframe at the default URL when the server answers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(WayfinderView, props())) })
    await act(async () => { /* flush the probe */ })
    const frame = container.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    expect(frame!.src).toBe(WAYFINDER_DEFAULT_URL)
    act(() => { root.unmount() })
    container.remove()
  })

  it('retry re-probes and mounts the iframe once the server comes up', async () => {
    let up = false
    globalThis.fetch = vi.fn().mockImplementation(() => {
      if (up) return Promise.resolve(new Response(null, { status: 200 }))
      return Promise.reject(new TypeError('Failed to fetch'))
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(WayfinderView, props())) })
    await act(async () => { /* flush the failing probe */ })
    expect(container.querySelector('iframe')).toBeNull()
    up = true
    const retry = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Retry'))
    expect(retry).toBeDefined()
    await act(async () => { retry!.click() })
    const frame = container.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    act(() => { root.unmount() })
    container.remove()
  })

  it('seeds the iframe from the persisted tab path (custom URL)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(WayfinderView, props({
        tab: { id: 'wayfinder', type: 'wayfinder', title: 'Wayfinder Map', path: 'http://localhost:9999/?dir=.plan/demo' },
      })))
    })
    await act(async () => { /* flush the probe */ })
    const frame = container.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    expect(frame!.src).toBe('http://localhost:9999/?dir=.plan/demo')
    act(() => { root.unmount() })
    container.remove()
  })
})

// ─── list mode tests ────────────────────────────────────────────────────────

describe('WayfinderView (list mode)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('renders the destination from map.md when tab.path is a local path', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(WayfinderView, props({
        tab: { id: 'wayfinder', type: 'wayfinder', title: 'Wayfinder Map', path: '/test/.plan' },
      })))
    })
    // Wait for the async loadPlan + setState.
    await act(async () => { /* flush */ })
    expect(container.textContent).toContain('docs-tmp 推演定稿 → arch_design 合并')
    act(() => { root.unmount() })
    container.remove()
  })

  it('groups tickets by status: open, claimed, resolved, out_of_scope', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(WayfinderView, props({
        tab: { id: 'wayfinder', type: 'wayfinder', title: 'Wayfinder Map', path: '/test/.plan' },
      })))
    })
    await act(async () => { /* flush */ })
    const text = container.textContent ?? ''
    // Open: T03
    expect(text).toContain('Open')
    expect(text).toContain('T03')
    // Claimed: T02
    expect(text).toContain('Claimed')
    expect(text).toContain('T02')
    // Resolved: T01
    expect(text).toContain('Resolved')
    expect(text).toContain('T01')
    // Out of scope: T04
    expect(text).toContain('Out of scope')
    expect(text).toContain('T04')
    // No iframe
    expect(container.querySelector('iframe')).toBeNull()
    act(() => { root.unmount() })
    container.remove()
  })

  it('shows type badge and claimed_by indicator', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(WayfinderView, props({
        tab: { id: 'wayfinder', type: 'wayfinder', title: 'Wayfinder Map', path: '/test/.plan' },
      })))
    })
    await act(async () => { /* flush */ })
    const text = container.textContent ?? ''
    expect(text).toContain('research')
    expect(text).toContain('grilling')
    expect(text).toContain('session-abc')
    act(() => { root.unmount() })
    container.remove()
  })
})
