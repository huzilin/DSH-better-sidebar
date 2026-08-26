/**
 * PlanView tests: the built-in plan tab reads `.plan/` files via the
 * sidebar fs.read API, derives ticket status per the TRACKER-MARKDOWN
 * contract, and renders a plain grouped list.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PlanView } from '../src/client/PlanView.tsx'
import type { TabComponentProps } from '../src/client/service.ts'
import type { FsTextResult } from '../src/client/api.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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
            name, path: `${path}/${name}`, isDir: false, hidden: false, isSymlink: false, broken: false,
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
    scope: { sessionId: 's1', cwd: '/test' },
    tab: { id: 'plan', type: 'plan', title: 'Plan' },
    visible: true,
    ...overrides,
  }
}

describe('PlanView', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('renders the destination from map.md', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(PlanView, props())) })
    await act(async () => { /* flush */ })
    expect(container.textContent).toContain('docs-tmp 推演定稿 → arch_design 合并')
    act(() => { root.unmount() })
    container.remove()
  })

  it('groups tickets by status', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(PlanView, props())) })
    await act(async () => { /* flush */ })
    const text = container.textContent ?? ''
    expect(text).toContain('Open')
    expect(text).toContain('T03')
    expect(text).toContain('Claimed')
    expect(text).toContain('T02')
    expect(text).toContain('Resolved')
    expect(text).toContain('T01')
    expect(text).toContain('Out of scope')
    expect(text).toContain('T04')
    act(() => { root.unmount() })
    container.remove()
  })

  it('shows type badge and claimed_by indicator', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(PlanView, props())) })
    await act(async () => { /* flush */ })
    const text = container.textContent ?? ''
    expect(text).toContain('research')
    expect(text).toContain('grilling')
    expect(text).toContain('session-abc')
    act(() => { root.unmount() })
    container.remove()
  })
})
