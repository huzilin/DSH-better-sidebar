/**
 * Lightweight SVG dependency graph for .plan/ wayfinder tickets.
 *
 * Renders blocked_by relationships as a directed acyclic graph with
 * topological layering — refined visual design with status stripes,
 * type badges, gradient arrows, and hover interactivity.
 * No external layout library, no mermaid chunk, pure frontend.
 */
import { useMemo, useState } from 'react'
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
  ticket: GraphTicket
  status: TicketStatus
  layer: number
}

const NODE_W = 200
const NODE_H = 44
const NODE_STRIPE_W = 5
const LAYER_GAP_X = 260
const NODE_GAP_Y = 64
const PADDING = 32

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

  const layers = new Map<number, number[]>()
  for (const t of tickets) {
    const n = ticketNum(t.file)
    const L = layer.get(n) ?? 0
    if (!layers.has(L)) layers.set(L, [])
    layers.get(L)!.push(n)
  }

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

// ─── Design tokens (DSH theme aligned) ───────────────────────────────────────

const STATUS_THEME: Record<TicketStatus, {
  stripe: string
  bg: string
  stroke: string
  text: string
  glow: string
  badge: string
  badgeBg: string
}> = {
  open: {
    stripe: 'var(--dsw-alias-label-secondary)',
    bg: 'var(--dsw-alias-bg-layer-1)',
    stroke: 'var(--dsw-alias-border-l1)',
    text: 'var(--dsw-alias-label-primary)',
    glow: 'none',
    badge: 'var(--dsw-alias-label-tertiary)',
    badgeBg: 'var(--dsw-alias-bg-base)',
  },
  claimed: {
    stripe: 'var(--dsw-alias-state-warn-primary)',
    bg: 'var(--dsw-alias-bg-layer-1)',
    stroke: 'var(--dsw-alias-state-warn-primary)',
    text: 'var(--dsw-alias-state-warn-label)',
    glow: '0 0 12px var(--dsw-alias-state-warn-primary)',
    badge: 'var(--dsw-alias-state-warn-label)',
    badgeBg: 'var(--dsw-alias-state-warn-tertiary)',
  },
  resolved: {
    stripe: 'var(--dsw-alias-state-success-primary)',
    bg: 'var(--dsw-alias-bg-layer-1)',
    stroke: 'var(--dsw-alias-state-success-primary)',
    text: 'var(--dsw-alias-state-success-label)',
    glow: '0 0 12px var(--dsw-alias-state-success-primary)',
    badge: 'var(--dsw-alias-state-success-label)',
    badgeBg: 'var(--dsw-alias-state-success-tertiary)',
  },
  out_of_scope: {
    stripe: 'var(--dsw-alias-label-tertiary)',
    bg: 'var(--dsw-alias-bg-layer-2)',
    stroke: 'var(--dsw-alias-border-l1)',
    text: 'var(--dsw-alias-label-tertiary)',
    glow: 'none',
    badge: 'var(--dsw-alias-label-tertiary)',
    badgeBg: 'var(--dsw-alias-bg-base)',
  },
}

const TYPE_COLORS: Record<string, string> = {
  research: '#7c6bff',
  grilling: '#f0a500',
  prototype: '#2ecc71',
  task: '#888',
}

// ─── SVG rendering ───────────────────────────────────────────────────────────

function GraphSvg({ nodes, edges }: { nodes: LayoutNode[]; edges: [number, number][] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  const width = PADDING * 2 + (nodes.length > 0 ? Math.max(...nodes.map(n => n.x)) + NODE_W : 200)
  const height = PADDING * 2 + (nodes.length > 0 ? Math.max(...nodes.map(n => n.y)) + NODE_H : 100)

  // Highlight edges connected to hovered node.
  const connectedEdges = useMemo(() => {
    if (hovered === null) return new Set<number>()
    const s = new Set<number>()
    edges.forEach(([from, to], i) => {
      if (from === hovered || to === hovered) s.add(i)
    })
    return s
  }, [hovered, edges])

  return (
    <svg width={width} height={height} className={css.planGraphSvg}>
      <defs>
        {/* Gradient arrowhead */}
        <marker id="arrow" viewBox="0 0 12 8" refX="11" refY="4" markerWidth="10" markerHeight="7" orient="auto">
          <path d="M0,1 L10,4 L0,7 L2,4 Z" fill="var(--dsw-alias-label-secondary)" />
        </marker>
        <marker id="arrow-active" viewBox="0 0 12 8" refX="11" refY="4" markerWidth="10" markerHeight="7" orient="auto">
          <path d="M0,1 L10,4 L0,7 L2,4 Z" fill="var(--dsw-alias-state-warn-primary)" />
        </marker>
        {/* Subtle grid pattern */}
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--dsw-alias-border-l1)" strokeWidth="0.3" opacity="0.4" />
        </pattern>
      </defs>
      {/* Background grid */}
      <rect width={width} height={height} fill="url(#grid)" />
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
        const isActive = connectedEdges.has(i)
        return (
          <path
            key={i}
            d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
            fill="none"
            stroke={isActive ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)'}
            strokeWidth={isActive ? 2.5 : 1.5}
            strokeOpacity={hovered !== null && !isActive ? 0.25 : 1}
            markerEnd={isActive ? 'url(#arrow-active)' : 'url(#arrow)'}
            style={{ transition: 'stroke-opacity 0.15s, stroke 0.15s' }}
          />
        )
      })}
      {/* Nodes */}
      {nodes.map(n => {
        const t = STATUS_THEME[n.status]
        const label = `${ticketNum(n.ticket.file)} · ${n.ticket.title}`
        const isHovered = hovered === n.id
        return (
          <g
            key={n.id}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'default' }}
          >
            {/* Shadow / glow */}
            {t.glow !== 'none' && (
              <rect
                x={n.x - 1} y={n.y - 1}
                width={NODE_W + 2} height={NODE_H + 2}
                rx="8" fill="none"
                stroke={t.stripe} strokeWidth="0" opacity="0.4"
                style={{ filter: isHovered ? 'none' : undefined }}
              />
            )}
            {/* Card body */}
            <rect
              x={n.x} y={n.y}
              width={NODE_W} height={NODE_H}
              rx="8"
              fill={t.bg}
              stroke={isHovered ? t.stripe : t.stroke}
              strokeWidth={isHovered ? 2 : 1}
              opacity={hovered !== null && !isHovered ? 0.5 : 1}
              style={{ transition: 'opacity 0.15s, stroke 0.15s' }}
            />
            {/* Left status stripe */}
            <rect
              x={n.x} y={n.y}
              width={NODE_STRIPE_W} height={NODE_H}
              rx="8" ry="8"
              fill={t.stripe}
            />
            <rect
              x={n.x + NODE_STRIPE_W - 2} y={n.y}
              width={2} height={NODE_H}
              fill={t.stripe}
            />
            {/* Type badge */}
            {n.ticket.type && (
              <>
                <rect
                  x={n.x + NODE_W - 52} y={n.y + 8}
                  width={44} height={20}
                  rx="4"
                  fill={TYPE_COLORS[n.ticket.type] ?? '#888'}
                  opacity="0.15"
                />
                <text
                  x={n.x + NODE_W - 30} y={n.y + NODE_H / 2 + 1}
                  fill={TYPE_COLORS[n.ticket.type] ?? '#888'}
                  fontSize="10" fontWeight="600" textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {n.ticket.type}
                </text>
              </>
            )}
            {/* Label */}
            <text
              x={n.x + NODE_STRIPE_W + 10}
              y={n.y + NODE_H / 2 + 1}
              fill={t.text}
              fontSize="13" fontWeight="500"
              dominantBaseline="middle"
            >
              {label.length > 20 ? label.slice(0, 19) + '…' : label}
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
        <span className={css.planGraphLegendItem} style={{ marginLeft: 8 }}>→ blocked_by</span>
      </div>
    </div>
  )
}

export type { GraphTicket }
