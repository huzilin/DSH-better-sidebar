/**
 * The built-in plan tab: a plain list view of `.plan/` wayfinder maps.
 *
 * Reads `map.md` + `tickets/*.md` via the sidebar `fs.read` API, derives
 * ticket status per the TRACKER-MARKDOWN contract, and renders a grouped
 * list — no external server, no star-map, no overhead. Defaults to the
 * current session's `cwd/.plan/`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from './locales.ts'
import type { TabComponentProps } from './service.ts'
import { api, type FsEntry } from './api.ts'
import css from './sidebar.module.css'

// ─── Frontmatter parsing (lightweight, per TRACKER-MARKDOWN) ──────────────────

interface ParsedTicket {
  file: string
  title: string
  type: string | undefined
  blockedBy: number[]
  resolved: boolean
  outOfScope: boolean
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
  const hasAnswer = /^## Answer\s*$/m.test(body) && /^## Answer\s*\n\S/m.test(body)
  const hasRuledOut = /^## Ruled out\s*$/m.test(body) && /^## Ruled out\s*\n\S/m.test(body)
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

type TicketStatus = 'resolved' | 'out_of_scope' | 'claimed' | 'open'
function displayStatus(t: ParsedTicket): TicketStatus {
  if (t.outOfScope) return 'out_of_scope'
  if (t.resolved) return 'resolved'
  if (t.claimedBy) return 'claimed'
  return 'open'
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadPlan(scope: TabComponentProps['scope'], planDir: string): Promise<{
  mapRaw: string
  tickets: ParsedTicket[]
  effortDir: string
} | null> {
  // Scan .plan/ for a subdirectory containing map.md (effort layer).
  // If .plan/map.md exists directly, use planDir itself.
  let effortDir = planDir
  const rootTree = await api.fsTree(scope, planDir)
  const hasDirectMap = rootTree.entries.some((e: FsEntry) => e.name === 'map.md' && !e.isDir)
  if (!hasDirectMap) {
    const subdirs = rootTree.entries.filter((e: FsEntry) => e.isDir)
    for (const d of subdirs) {
      const subTree = await api.fsTree(scope, d.path)
      if (subTree.entries.some((e: FsEntry) => e.name === 'map.md' && !e.isDir)) {
        effortDir = d.path
        break
      }
    }
  }
  const [mapRes, treeRes] = await Promise.all([
    api.fsRead(scope, `${effortDir}/map.md`),
    api.fsTree(scope, `${effortDir}/tickets`),
  ])
  const mapRaw = mapRes.kind === 'text' ? mapRes.content : ''
  const mdFiles = treeRes.entries.filter((e: FsEntry) => e.name.endsWith('.md') && !e.isDir)
  const raws = await Promise.all(
    mdFiles.map((e: FsEntry) => api.fsRead(scope, e.path).then(r => r.kind === 'text' ? r.content : '')),
  )
  const tickets = mdFiles.map((e: FsEntry, i: number) => deriveTicketStatus(e.name, raws[i] ?? ''))
  return { mapRaw, tickets, effortDir }
}

// ─── Components ──────────────────────────────────────────────────────────────

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

export function PlanView(props: TabComponentProps) {
  const { scope } = props

  const [mapRaw, setMapRaw] = useState<string | null>(null)
  const [tickets, setTickets] = useState<ParsedTicket[]>([])
  const [effortDir, setEffortDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const dir = scope.cwd ? `${scope.cwd}/.plan` : '.plan'
    try {
      const res = await loadPlan(scope, dir)
      if (!res) { setError('empty'); setLoading(false); return }
      setMapRaw(res.mapRaw)
      setTickets(res.tickets)
      setEffortDir(res.effortDir)
    } catch {
      setError('failed')
    } finally {
      setLoading(false)
    }
  }, [scope.sessionId, scope.cwd])

  useEffect(() => { void load() }, [load])

  const destination = useMemo(() => {
    if (!mapRaw) return null
    const m = mapRaw.match(/## Destination\s*\n([\s\S]*?)(?=\n## |\n$)/)
    return m?.[1]?.trim().split('\n')[0]?.trim() ?? null
  }, [mapRaw])

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
  if (error) return <div className={css.browserStart}>{t('wayfinderListEmpty')}</div>

  return (
    <div className={css.wayfinderList}>
      {destination && <div className={css.wayfinderDestination}>{destination}</div>}
      {statusOrder.filter(s => groups[s].length > 0).map(s => (
        <div key={s} className={css.wayfinderGroup}>
          <div className={css.wayfinderGroupTitle}>{statusLabels[s]} ({groups[s].length})</div>
          {groups[s].map(t => <TicketRow key={t.file} ticket={t} planDir={effortDir} scope={scope} />)}
        </div>
      ))}
      {tickets.length === 0 && !loading && (
        <div className={css.browserStart}>{t('wayfinderListEmpty')}</div>
      )}
    </div>
  )
}
