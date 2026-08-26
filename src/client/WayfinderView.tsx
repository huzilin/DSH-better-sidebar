/**
 * The built-in wayfinder tab: two view modes.
 *
 * **Iframe mode** (tab.path starts with `http`): embeds the external
 * `wayfinder-maps serve` viewer (localhost:7777). The plugin probes the port
 * and when the server is down shows the start command with copy + retry
 * instead of a blank frame.
 *
 * **List mode** (tab.path is a local path — the `.plan/` directory):
 * reads `map.md` + `tickets/*.md` via the sidebar's `fs.read` API,
 * derives ticket status per the TRACKER-MARKDOWN contract, and renders a
 * plain grouped list — no external server, no star-map, no overhead.
 *
 * The user switches between modes with the toggle button; the tab persists
 * the mode choice across reloads (through `tab.path` — `http` = iframe,
 * local path = list).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconRefreshOutline14, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import type { TabComponentProps } from './service.ts'
import { api, type FsEntry } from './api.ts'
import css from './sidebar.module.css'

// ─── Constants ───────────────────────────────────────────────────────────────

/** The local address of `wayfinder-maps serve` (PORT env override). */
export const WAYFINDER_DEFAULT_URL = 'http://localhost:7777/'

/** Cap on the reachability probe. */
const WAYFINDER_PROBE_TIMEOUT_MS = 3_000

/** The command offered for one-tap copy. */
export const WAYFINDER_START_COMMAND = 'wayfinder-maps serve'

export const WAYFINDER_IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'

// ─── Frontmatter parsing (lightweight, per TRACKER-MARKDOWN) ──────────────────

interface ParsedTicket {
  /** Raw filename (e.g. `01-skill-reuse.md`). */
  file: string
  /** Title from `# Title` heading. */
  title: string
  /** `type:` field (research | prototype | grilling | task). */
  type: string | undefined
  /** `blocked_by:` field — comma-separated ticket numbers. */
  blockedBy: number[]
  /** Whether `## Answer` heading exists with prose under it. */
  resolved: boolean
  /** Whether `## Ruled out` heading exists with prose under it. */
  outOfScope: boolean
  /** `claimed_by:` field. */
  claimedBy: string | undefined
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {}
  let body = raw
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m && m[1] != null) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([^:]+):\s*(.*)$/)
      if (kv?.[1] != null && kv?.[2] != null) fm[kv[1].trim()] = kv[2].trim()
    }
    body = m[2] ?? ''
  }
  return { fm, body }
}

function deriveTicketStatus(file: string, raw: string): ParsedTicket {
  const { fm, body } = parseFrontmatter(raw)
  // Heading outside fenced code blocks (simplified: fence-naive for lightweight parser)
  const hasAnswer = /^## Answer\s*$/m.test(body) && /^## Answer\s*\n\S/m.test(body)
  const hasRuledOut = /^## Ruled out\s*$/m.test(body) && /^## Ruled out\s*\n\S/m.test(body)
  // First `# Title` line
  const titleMatch = raw.match(/^#\s+(.+)$/m)
  return {
    file,
    title: titleMatch?.[1]?.replace(/`[^`]*`/g, '')?.trim() ?? file,
    type: fm.type,
    blockedBy: (fm.blocked_by ?? '').split(/[,\s]+/).map(Number).filter(Boolean),
    resolved: hasAnswer,
    outOfScope: hasRuledOut,
    claimedBy: fm.claimed_by,
  }
}

/** Derive display status from parsed ticket fields. */
type TicketStatus = 'resolved' | 'out_of_scope' | 'claimed' | 'open'
function displayStatus(t: ParsedTicket): TicketStatus {
  if (t.outOfScope) return 'out_of_scope'
  if (t.resolved) return 'resolved'
  if (t.claimedBy) return 'claimed'
  return 'open'
}

// ─── List view ───────────────────────────────────────────────────────────────

/** Read the .plan directory and derive all ticket statuses. */
async function loadPlan(scope: TabComponentProps['scope'], planDir: string): Promise<{
  mapRaw: string
  tickets: ParsedTicket[]
} | null> {
  // Read map.md + list tickets directory in parallel.
  const [mapRes, treeRes] = await Promise.all([
    api.fsRead(scope, `${planDir}/map.md`),
    api.fsTree(scope, `${planDir}/tickets`),
  ])
  const mapRaw = mapRes.kind === 'text' ? mapRes.content : ''
  const mdFiles = treeRes.entries.filter((e: FsEntry) => e.name.endsWith('.md') && !e.isDir)
  // Read all ticket files in parallel.
  const raws = await Promise.all(
    mdFiles.map((e: FsEntry) => api.fsRead(scope, e.path).then(r => r.kind === 'text' ? r.content : '')),
  )
  const tickets = mdFiles.map((e: FsEntry, i: number) => deriveTicketStatus(e.name, raws[i] ?? ''))
  return { mapRaw, tickets }
}

function TicketRow({ ticket, planDir, scope }: { ticket: ParsedTicket; planDir: string; scope: TabComponentProps['scope'] }) {
  const [expanded, setExpanded] = useState(false)
  const [body, setBody] = useState<string | null>(null)
  const status = displayStatus(ticket)
  const typeBadge = ticket.type ?? 'task'

  const toggle = async (): Promise<void> => {
    if (expanded) { setExpanded(false); return }
    if (body === null) {
      const res = await api.fsRead(scope, `${planDir}/tickets/${ticket.file}`)
      if (res.kind === 'text') setBody(res.content)
    }
    setExpanded(true)
  }

  return (
    <div className={css.wayfinderTicket}>
      <button type="button" className={css.wayfinderTicketHead} onClick={() => void toggle()}>
        <span className={`${css.wayfinderStatusDot} ${css[`wayfinderStatus_${status}`]}`} />
        <span className={css.wayfinderTicketTitle}>{ticket.title}</span>
        <span className={css.wayfinderTicketMeta}>
          <span className={css.wayfinderTypeBadge}>{typeBadge}</span>
          {ticket.claimedBy ? <span className={css.wayfinderClaimedBy}>{ticket.claimedBy}</span> : null}
        </span>
      </button>
      {expanded && body ? (
        <div className={css.wayfinderTicketBody}>
          <pre className={css.wayfinderTicketPre}>{body.split('\n').slice(0, 60).join('\n')}</pre>
        </div>
      ) : null}
    </div>
  )
}

function ListView({ scope, planDir }: { scope: TabComponentProps['scope']; planDir: string }) {
  const [mapRaw, setMapRaw] = useState<string | null>(null)
  const [tickets, setTickets] = useState<ParsedTicket[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await loadPlan(scope, planDir)
      if (!res) { setError(t('wayfinderListEmpty')); setLoading(false); return }
      setMapRaw(res.mapRaw)
      setTickets(res.tickets)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [scope, planDir])

  useEffect(() => { void load() }, [load])

  // Extract Destination from map.md (simple: line after `## Destination` up to next heading)
  const destination = useMemo(() => {
    if (!mapRaw) return null
    const m = mapRaw.match(/## Destination\s*\n([\s\S]*?)(?=\n## |\n$)/)
    return m?.[1]?.trim().split('\n')[0]?.trim() ?? null
  }, [mapRaw])

  // Group tickets by display status.
  const groups = useMemo(() => {
    const g: Record<TicketStatus, ParsedTicket[]> = { resolved: [], out_of_scope: [], claimed: [], open: [] }
    for (const t of tickets) g[displayStatus(t)].push(t)
    return g
  }, [tickets])

  const statusOrder: TicketStatus[] = ['open', 'claimed', 'resolved', 'out_of_scope']
  const statusLabels: Record<TicketStatus, string> = {
    open: t('wayfinderListOpen'),
    claimed: t('wayfinderListClaimed'),
    resolved: t('wayfinderListResolved'),
    out_of_scope: t('wayfinderListOutOfScope'),
  }

  if (loading) return <div className={css.browserStart}>{t('wayfinderChecking')}</div>
  if (error) return <div className={css.browserStart} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div>

  return (
    <div className={css.wayfinderList}>
      {destination && <div className={css.wayfinderDestination}>{destination}</div>}
      {statusOrder.filter(s => groups[s].length > 0).map(s => (
        <div key={s} className={css.wayfinderGroup}>
          <div className={css.wayfinderGroupTitle}>{statusLabels[s]} ({groups[s].length})</div>
          {groups[s].map(t => <TicketRow key={t.file} ticket={t} planDir={planDir} scope={scope} />)}
        </div>
      ))}
      {tickets.length === 0 && !loading && (
        <div className={css.browserStart}>{t('wayfinderListEmpty')}</div>
      )}
    </div>
  )
}

// ─── Iframe mode (existing, unchanged) ───────────────────────────────────────

function IframeMode({ url, visible }: { url: string; visible: boolean }) {
  const [reachable, setReachable] = useState<boolean | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState(false)

  const probe = useCallback(async (): Promise<void> => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), WAYFINDER_PROBE_TIMEOUT_MS)
    try {
      await fetch(url, { mode: 'no-cors', signal: controller.signal })
      setReachable(true)
    } catch {
      setReachable(false)
    } finally {
      window.clearTimeout(timer)
    }
  }, [url])

  useEffect(() => { if (visible) void probe() }, [visible, probe])

  const copyCommand = async (): Promise<void> => {
    const written = await writeClipboard(WAYFINDER_START_COMMAND)
    if (written) setCopied(true)
  }

  if (reachable === true) {
    return (
      <iframe
        key={reloadKey}
        className={css.browserFrame}
        src={url}
        sandbox={WAYFINDER_IFRAME_SANDBOX}
        title={t('wayfinder')}
      />
    )
  }
  if (reachable === null) {
    return <div className={css.browserStart}>{t('wayfinderChecking')}</div>
  }
  return (
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
          onClick={() => { setReloadKey(k => k + 1); void probe() }}
        >
          <IconRefreshOutline14 /> {t('wayfinderRetry')}
        </button>
      </div>
    </div>
  )
}

// ─── Root component ──────────────────────────────────────────────────────────

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

export function WayfinderView(props: TabComponentProps) {
  const { tab, scope, visible } = props
  const path = tab.path ?? WAYFINDER_DEFAULT_URL
  const isIframe = isHttpUrl(path)

  return (
    <div className={css.browser}>
      {isIframe ? (
        <IframeMode url={path} visible={visible} />
      ) : (
        <ListView scope={scope} planDir={path} />
      )}
    </div>
  )
}
