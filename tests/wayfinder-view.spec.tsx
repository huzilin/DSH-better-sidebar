/**
 * WayfinderView tests: the built-in wayfinder tab embeds the external
 * `wayfinder-maps serve` viewer (localhost:7777). The plugin is browser-side
 * only and cannot spawn the server, so the view probes the port on mount and
 * — when the server is down — renders the start command with copy and retry
 * actions instead of a blank frame; when it answers, an iframe mounts.
 *
 * Static content is covered with renderToString (effects do not run, so the
 * probing state renders); the interactive paths run under jsdom with fetch
 * stubbed (probe rejects → notice, resolves → iframe, retry re-probes).
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

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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

describe('WayfinderView (render)', () => {
  it('renders the probing state while effects have not run (SSR)', () => {
    const html = renderToString(createElement(WayfinderView, props()))
    expect(html).toContain('Checking the Wayfinder server…')
  })
})

describe('WayfinderView (interactive)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
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
