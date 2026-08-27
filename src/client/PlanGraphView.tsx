/**
 * Lightweight SVG dependency graph for .plan/ wayfinder tickets.
 *
 * Renders blocked_by relationships as a directed acyclic graph with
 * topological layering (nodes arranged by dependency depth) — no external
 * layout library, no mermaid chunk, pure frontend. Status colors match
 * the list view (resolved/claimed/open/out_of_scope).
 */
import { useMemo } from 'react'
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

/** Extract the numeric ticket number from filename (e.g. "01-skill-reuse.md" → 1). */
function ticketNum(file: string): number {
  const m = file.match(/^(\d+)/)
  return m ? Number(m[1]) : 0
}

// ─── Layout ──────────────────────────────────────────────────────────────────

interface LayoutNode {
  id: number
  x: number
  y: number
  ticket: GraphTicket
  status: TicketStatus
  layer: number
}

const NODE_W = 180
const NODE_H = 36
const LAYER_GAP_X = 240
const NODE_GAP_Y = 56
const PADDING = 24

function layoutGraph(tickets: GraphTicket[]): { nodes: LayoutNode[]; edges: [number, number][] } {
  const byNum = new Map<number, GraphTicket>()
  for (const t of tickets) byNum.set(ticketNum(t.file), t)

  // Build adjacency: blocked_by → ticket
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

  // Group nodes by layer.
  const layers = new Map<number, number[]>()
  for (const t of tickets) {
    const n = ticketNum(t.file)
    const L = layer.get(n) ?? 0
    if (!layers.has(L)) layers.set(L, [])
    layers.get(L)!.push(n)
  }
  const maxLayer = Math.max(0, ...layers.keys())

  // Assign coordinates: columns left-to-right, rows top-to-bottom within each column.
  const nodes: LayoutNode[] = []
  for (const [L, nums] of layers) {
    nums.sort((a, b) => a - b)
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!
      const ticket = byNum.get(n)
      if (!ticket) continue
      nodes.push({
        id: n,
        x: PADDING + L * LAYER_GAP_X,
        y: PADDING + i * NODE_GAP_Y,
        ticket,
        status: displayStatus(ticket),
        layer: L,
      })
    }
  }

  return { nodes, edges }
}

// ─── SVG rendering ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<TicketStatus, { bg: string; stroke: string; text: string }> = {
  open: { bg: '#1e1e3a', stroke: '#4a4a6a', text: '#e0e0e0' },
  claimed: { bg: '#3a2800', stroke: '#f0a500', text: '#f0a500' },
  resolved: { bg: '#1a3a2a', stroke: '#2ecc71', text: '#2ecc71' },
  out_of_scope: { bg: '#2a2a3a', stroke: '#555', text: '#888' },
}

function GraphSvg({ nodes, edges }: { nodes: LayoutNode[]; edges: [number, number][] }) {
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  const width = PADDING * 2 + (nodes.length > 0 ? Math.max(...nodes.map(n => n.x)) + NODE_W : 0)
  const height = PADDING * 2 + (nodes.length > 0 ? Math.max(...nodes.map(n => n.y)) + NODE_H : 0)

  return (
    <svg width={width} height={height} className={css.planGraphSvg}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto">
          <path d="M0,0 L10,3 L0,6 Z" fill="#555" />
        </marker>
      </defs>
      {/* Edges */}
      {edges.map(([from, to], i) => {
        const a = byId.get(from)
        const b = byId.get(to)
        if (!a || !b) return null
        const x1 = a.x + NODE_W
        const y1 = a.y + NODE_H / 2
        const x2 = b.x
        const y2 = b.y + NODE_H / 2
        const mx = (x1 + x2) / 2
        return (
          <path
            key={i}
            d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
            fill="none"
            stroke="#4a4a6a"
            strokeWidth="1.5"
            markerEnd="url(#arrow)"
          />
        )
      })}
      {/* Nodes */}
      {nodes.map(n => {
        const c = STATUS_COLORS[n.status]
        const label = `${ticketNum(n.ticket.file)} · ${n.ticket.title}`
        return (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx="6" fill={c.bg} stroke={c.stroke} strokeWidth="1.5" />
            <text x={n.x + 10} y={n.y + NODE_H / 2 + 1} fill={c.text} fontSize="12" dominantBaseline="middle">
              {label.length > 22 ? label.slice(0, 21) + '…' : label}
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
    return <div className={css.browserStart}>无票可渲染</div>
  }

  return (
    <div className={css.planGraphContainer}>
      <GraphSvg nodes={nodes} edges={edges} />
      <div className={css.planGraphLegend}>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_resolved}`} /> resolved</span>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_claimed}`} /> claimed</span>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_open}`} /> open</span>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_out_of_scope}`} /> out of scope</span>
        <span className={css.planGraphLegendItem}>→ blocked_by</span>
      </div>
    </div>
  )
}

export type { GraphTicket }
