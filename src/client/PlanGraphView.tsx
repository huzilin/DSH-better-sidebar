/**
 * Lightweight SVG dependency graph for .plan/ wayfinder tickets.
 *
 * Visual style: hand-drawn look with colored borders by ticket type,
 * icons, clean arrows, Start/Destination labels, and fog nodes.
 * Zero external dependencies.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { t } from './locales.ts'
import css from './sidebar.module.css'

type TicketStatus = 'resolved' | 'out_of_scope' | 'claimed' | 'open'

interface GraphTicket {
  file: string
  title: string
  type: string | undefined
  blockedBy: number[]
  resolved: boolean
  outOfScope: boolean
  claimedBy: string | undefined
}

function displayStatus(t: GraphTicket): TicketStatus {
  if (t.outOfScope) return 'out_of_scope'
  if (t.resolved) return 'resolved'
  if (t.claimedBy) return 'claimed'
  return 'open'
}

function ticketNum(file: string): number {
  const m = file.match(/^(\d+)/)
  return m ? Number(m[1]) : 0
}

// ─── Layout ──────────────────────────────────────────────────────────────────

interface LayoutNode {
  id: number
  x: number
  y: number
  w: number
  h: number
  ticket: GraphTicket
  status: TicketStatus
  layer: number
}

const NODE_W = 220
const NODE_H = 48
const LAYER_GAP_X = 100
const NODE_GAP_Y = 72
const PADDING = 60
const TOP_LABEL_H = 80
const BOTTOM_LABEL_H = 60

function layoutGraph(tickets: GraphTicket[]): { nodes: LayoutNode[]; edges: [number, number][] } {
  const byNum = new Map<number, GraphTicket>()
  for (const t of tickets) byNum.set(ticketNum(t.file), t)

  const edges: [number, number][] = []
  for (const t of tickets) {
    const n = ticketNum(t.file)
    for (const blocker of t.blockedBy) {
      if (byNum.has(blocker)) edges.push([blocker, n])
    }
  }

  // Topological layering via longest path from roots.
  const layer = new Map<number, number>()
  const visited = new Set<number>()
  function dfs(num: number): number {
    if (layer.has(num)) return layer.get(num)!
    if (visited.has(num)) return 0
    visited.add(num)
    const blockerNums = byNum.get(num)?.blockedBy.filter(b => byNum.has(b)) ?? []
    const maxParent = blockerNums.length > 0 ? Math.max(...blockerNums.map(dfs)) : 0
    const L = maxParent + 1
    layer.set(num, L)
    return L
  }
  for (const t of tickets) dfs(ticketNum(t.file))

  // Group by layer.
  const layers = new Map<number, number[]>()
  for (const t of tickets) {
    const n = ticketNum(t.file)
    const L = layer.get(n) ?? 0
    if (!layers.has(L)) layers.set(L, [])
    layers.get(L)!.push(n)
  }

  // Assign coordinates.
  const nodes: LayoutNode[] = []
  let curX = PADDING
  for (const [L, nums] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    nums.sort((a, b) => a - b)
    let curY = TOP_LABEL_H + PADDING
    for (const n of nums) {
      const ticket = byNum.get(n)
      if (!ticket) continue
      nodes.push({
        id: n, x: curX, y: curY, w: NODE_W, h: NODE_H,
        ticket, status: displayStatus(ticket), layer: L,
      })
      curY += NODE_H + NODE_GAP_Y
    }
    curX += NODE_W + LAYER_GAP_X
  }

  return { nodes, edges }
}

// ─── Design tokens ───────────────────────────────────────────────────────────

const TYPE_THEME: Record<string, { icon: string; color: string }> = {
  research: { icon: '🔍', color: '#7c6bff' },
  grilling: { icon: '🔥', color: '#ff6b6b' },
  prototype: { icon: '🛠️', color: '#ffa94d' },
  task: { icon: '⚡', color: '#ff922b' },
}
const DEFAULT_TYPE = { icon: '?', color: '#888' }

const STATUS_FILLS: Record<TicketStatus, string> = {
  open: '#1a1a2e',
  claimed: '#1a1a2e',
  resolved: '#1a2e1a',
  out_of_scope: '#1a1a1a',
}

// ─── SVG rendering ───────────────────────────────────────────────────────────

function GraphSvg({ nodes, edges }: { nodes: LayoutNode[]; edges: [number, number][] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  const contentW = nodes.length > 0 ? Math.max(...nodes.map(n => n.x + n.w)) + PADDING : 400
  const contentH = nodes.length > 0
    ? TOP_LABEL_H + Math.max(...nodes.map(n => n.y + n.h)) + BOTTOM_LABEL_H + PADDING
    : 300

  const connectedEdges = useMemo(() => {
    if (hovered === null) return new Set<number>()
    const s = new Set<number>()
    edges.forEach(([from, to], i) => {
      if (from === hovered || to === hovered) s.add(i)
    })
    return s
  }, [hovered, edges])

  const dimmed = hovered !== null

  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${contentW} ${contentH}`} preserveAspectRatio="xMidYMid meet">
      {/* Background */}
      <rect width={contentW} height={contentH} fill="#0a0a14" />

      {/* Start label */}
      <text x={contentW / 2} y="30" textAnchor="middle" fill="#ffffff" fontSize="22" fontWeight="bold" fontFamily="sans-serif">
        🚩 Start
      </text>
      <text x={contentW / 2} y="52" textAnchor="middle" fill="#888" fontSize="11" fontFamily="sans-serif">
        路径起点 — 从模糊想法到清晰路线
      </text>

      {/* Destination label */}
      <text x={contentW / 2} y={contentH - 15} textAnchor="middle" fill="#ffffff" fontSize="22" fontWeight="bold" fontFamily="sans-serif">
        🚩 Destination
      </text>

      {/* Edges — straight lines with arrowheads */}
      <defs>
        <marker id="arrowhead" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffffff" />
        </marker>
        <marker id="arrowhead-dim" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#444466" />
        </marker>
      </defs>

      {edges.map(([from, to], i) => {
        const a = byId.get(from)
        const b = byId.get(to)
        if (!a || !b) return null
        const x1 = a.x + a.w / 2
        const y1 = a.y + a.h
        const x2 = b.x + b.w / 2
        const y2 = b.y
        const isActive = connectedEdges.has(i)
        return (
          <line
            key={`e${i}`}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={isActive ? '#ffffff' : dimmed ? '#333355' : '#666688'}
            strokeWidth={isActive ? 2.5 : 1.8}
            markerEnd={isActive ? 'url(#arrowhead)' : 'url(#arrowhead-dim)'}
          />
        )
      })}

      {/* Nodes */}
      {nodes.map(n => {
        const tt = TYPE_THEME[n.ticket.type ?? ''] ?? DEFAULT_TYPE
        const fill = STATUS_FILLS[n.status]
        const isHovered = hovered === n.id
        const opacity = dimmed && !isHovered ? 0.35 : 1
        const borderColor = isHovered ? '#ffffff' : tt.color
        return (
          <g
            key={n.id}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'pointer', opacity, transition: 'opacity 0.15s' }}
          >
            {/* Node body */}
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="8" ry="8"
              fill={fill} stroke={borderColor} strokeWidth={isHovered ? 2.5 : 2} />
            {/* Icon area (left side) */}
            <rect x={n.x} y={n.y} width={n.h} height={n.h} rx="8" ry="8"
              fill={fill} stroke={borderColor} strokeWidth={0} />
            <text x={n.x + n.h / 2} y={n.y + n.h / 2 + 1} fontSize="18" textAnchor="middle" dominantBaseline="middle">
              {tt.icon}
            </text>
            {/* Ticket number */}
            <text x={n.x + n.h + 10} y={n.y + 14} fontSize="10" fill="#888" fontFamily="monospace">
              {ticketNum(n.ticket.file)}
            </text>
            {/* Title */}
            <text x={n.x + n.h + 10} y={n.y + 30} fontSize="13" fontWeight="500" fill="#e0e0f0" fontFamily="sans-serif">
              {n.ticket.title.length > 18 ? n.ticket.title.slice(0, 17) + '…' : n.ticket.title}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function PlanGraphView({ tickets }: { tickets: GraphTicket[] }) {
  const { nodes, edges } = useMemo(() => layoutGraph(tickets), [tickets])

  if (tickets.length === 0) {
    return <div className={css.browserStart}>{t('wayfinderListEmpty')}</div>
  }

  return (
    <div className={css.planGraphContainer}>
      <GraphSvg nodes={nodes} edges={edges} />
      <div className={css.planGraphLegend}>
        {Object.entries(TYPE_THEME).map(([type, { icon, color }]) => (
          <span key={type} className={css.planGraphLegendItem}>
            <span style={{ color, fontSize: '14px' }}>{icon}</span> {type}
          </span>
        ))}
        <span className={css.planGraphLegendItem}>→ blocked_by</span>
      </div>
    </div>
  )
}

export type { GraphTicket }
