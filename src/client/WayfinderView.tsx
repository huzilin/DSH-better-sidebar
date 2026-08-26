/**
 * The built-in wayfinder tab: the local wayfinder-maps viewer
 * (https://github.com/rengwu/wayfinder-maps) embedded as an iframe.
 *
 * The viewer is served by the EXTERNAL `wayfinder-maps serve` binary
 * (localhost:7777 by default). This plugin is browser-side only and cannot
 * spawn that process — the server is started (and kept running) in a terminal
 * on the DSH machine. The tab probes the port on mount and whenever it
 * becomes visible again, and when the server is down shows the start command
 * instead of a blank frame.
 *
 * Sandboxing: the viewer is a plain ES-module SPA, and module scripts are
 * fetched under CORS rules — an opaque origin (the browser tab's sandbox)
 * would silently refuse to load them. This iframe therefore KEEPS its own
 * origin (localhost:PORT), never the GUI's: it cannot read GUI storage,
 * reach /sidebar/api, or (no allow-top-navigation) navigate the shell away.
 * The only data it can see is the read-only map files the serve binary
 * itself exposes. The browser tab's loopback refusal intentionally does not
 * apply here: the URL is local by design.
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefreshOutline14, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import type { TabComponentProps } from './service.ts'
import css from './sidebar.module.css'

/** The local address of `wayfinder-maps serve` (PORT env override). */
export const WAYFINDER_DEFAULT_URL = 'http://localhost:7777/'

/** Cap on the reachability probe: a refused connection fails fast, but a
 *  wedged host must not leave the tab stuck on "checking". */
const WAYFINDER_PROBE_TIMEOUT_MS = 3_000

/** The `wayfinder-maps serve` command offered for one-tap copy. */
export const WAYFINDER_START_COMMAND = 'wayfinder-maps serve'

/**
 * The wayfinder app is an ES-module SPA: module scripts follow CORS rules, so
 * an opaque origin (the browser tab's sandbox, see BrowserView.tsx) would
 * silently refuse to load them. The iframe therefore keeps its own origin —
 * localhost:PORT, not the GUI's — which is exactly the origin the read-only
 * viewer already runs as in a standalone browser tab. No allow-top-navigation:
 * the embedded page must not navigate the shell away.
 */
export const WAYFINDER_IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'

export function WayfinderView(props: TabComponentProps) {
  const { tab, visible } = props
  // Seeded from the tab (openTab({ path }) / tab.path persistence) so a
  // reload restores a custom URL; defaults to the serve address.
  const [url] = useState<string>(tab.path ?? WAYFINDER_DEFAULT_URL)
  /** null = probing, true = reachable, false = down. */
  const [reachable, setReachable] = useState<boolean | null>(null)
  /** Bumped on retry to remount the iframe. */
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState(false)

  const probe = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), WAYFINDER_PROBE_TIMEOUT_MS)
    try {
      // mode: 'no-cors' — the serve API sends no CORS headers; an opaque
      // response is enough to know the port answers. A refused connection
      // rejects, which is the exact "server is down" signal.
      await fetch(url, { mode: 'no-cors', signal: controller.signal })
      setReachable(true)
    } catch {
      setReachable(false)
    } finally {
      window.clearTimeout(timer)
    }
  }, [url])

  // Probe on mount and whenever the tab becomes visible again (the panel may
  // have been collapsed while the user started the server elsewhere). The
  // existing verdict is kept while re-probing so the iframe does not blink.
  useEffect(() => {
    if (visible) void probe()
  }, [visible, probe])

  const copyCommand = async (): Promise<void> => {
    const written = await writeClipboard(WAYFINDER_START_COMMAND)
    if (written) setCopied(true)
  }

  return (
    <div className={css.browser}>
      {reachable === true ? (
        <iframe
          key={reloadKey}
          className={css.browserFrame}
          src={url}
          sandbox={WAYFINDER_IFRAME_SANDBOX}
          title={t('wayfinder')}
        />
      ) : reachable === null ? (
        <div className={css.browserStart}>{t('wayfinderChecking')}</div>
      ) : (
        <div className={css.browserBlocked}>
          <div className={css.browserBlockedTitle}>{t('wayfinderNotRunning')}</div>
          <div className={css.browserBlockedDesc}>{t('wayfinderStartHint')}</div>
          <code className={css.browserBlockedCommand}>{WAYFINDER_START_COMMAND}</code>
          <div className={css.browserBlockedActions}>
            <button type="button" className={css.browserBlockedButton} onClick={() => void copyCommand()}>
              {copied ? t('wayfinderCopied') : t('wayfinderCopy')}
            </button>
            <button
              type="button"
              className={css.browserBlockedButton}
              onClick={() => {
                setReloadKey((key) => key + 1)
                void probe()
              }}
            >
              <IconRefreshOutline14 /> {t('wayfinderRetry')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}