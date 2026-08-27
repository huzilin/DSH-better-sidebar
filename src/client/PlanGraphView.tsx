/**
 * Lightweight SVG dependency graph for .plan/ wayfinder tickets.
 *
 * Features: topological layering layout, status-colored nodes, zoom/pan
 * (mouse wheel + drag), click-to-select detail panel, gradient arrows,
 * grid background, hover highlight. Zero external dependencies.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

const NODE_PAD_X = 16
const NODE_PAD_Y = 8
const NODE_MIN_W = 160
const NODE_MAX_W = 260
const NODE_H = 44
const LAYER_GAP_X = 80
const NODE_GAP_Y = 20
const PADDING = 48

function measureNodeWidth(label: string): number {
  // Approximate: ~7.5px per char for 13px font + padding + badge + stripe
  const textW = Math.min(label.length * 7.5 + NODE_PAD_X * 2 + 60, NODE_MAX_W)
  return Math.max(textW, NODE_MIN_W)
}

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

  // Assign coordinates with variable-width nodes.
  const nodes: LayoutNode[] = []
  const layerX = new Map<number, number>()
  let curX = PADDING

  for (const [L, nums] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    nums.sort((a, b) => a - b)
    let maxW = 0
    let curY = PADDING
    for (const n of nums) {
      const ticket = byNum.get(n)
      if (!ticket) continue
      const label = `${ticketNum(ticket.file)} · ${ticket.title}`
      const w = measureNodeWidth(label)
      if (w > maxW) maxW = w
      nodes.push({
        id: n, x: curX, y: curY, w, h: NODE_H,
        ticket, status: displayStatus(ticket), layer: L,
      })
      curY += NODE_H + NODE_GAP_Y
    }
    layerX.set(L, curX)
    curX += maxW + LAYER_GAP_X
  }

  return { nodes, edges }
}

// ─── Design tokens (hardcoded for SVG — CSS vars don't inherit reliably) ─────

const STATUS_THEME: Record<TicketStatus, {
  stripe: string; bg: string; stroke: string; text: string
  badge: string; badgeBg: string
}> = {
  open: {
    stripe: '#8888bb',
    bg: '#282848',
    stroke: '#5a5a8a',
    text: '#e0e0f0',
    badge: '#aaaacc',
    badgeBg: '#1e1e38',
  },
  claimed: {
    stripe: '#ffbb33',
    bg: '#3a3010',
    stroke: '#ffbb33',
    text: '#ffe080',
    badge: '#ffbb33',
    badgeBg: '#3a3010',
  },
  resolved: {
    stripe: '#44dd88',
    bg: '#1a3828',
    stroke: '#44dd88',
    text: '#aaffcc',
    badge: '#44dd88',
    badgeBg: '#1a3828',
  },
  out_of_scope: {
    stripe: '#555577',
    bg: '#1e1e38',
    stroke: '#444466',
    text: '#7777aa',
    badge: '#6666aa',
    badgeBg: '#1a1a30',
  },
}

const TYPE_COLORS: Record<string, string> = {
  research: '#7c6bff', grilling: '#f0a500', prototype: '#2ecc71', task: '#888',
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function DetailPanel({ node, onClose }: { node: LayoutNode; onClose: () => void }) {
  const t = STATUS_THEME[node.status]
  const label = `${ticketNum(node.ticket.file)} · ${node.ticket.title}`
  return (
    <div className={css.planGraphDetail}>
      <div className={css.planGraphDetailHeader}>
        <span className={`${css.wayfinderStatusDot} ${css[`wayfinderStatus_${node.status}`]}`} />
        <span className={css.planGraphDetailTitle}>{label}</span>
        <button type="button" className={css.wayfinderToggleBtn} onClick={onClose}>✕</button>
      </div>
      <div className={css.planGraphDetailMeta}>
        {node.ticket.type && <span className={css.wayfinderTypeBadge}>{node.ticket.type}</span>}
        {node.ticket.claimedBy && <span className={css.wayfinderClaimedBy}>{node.ticket.claimedBy}</span>}
        <span className={css.wayfinderTypeBadge}>layer {node.layer}</span>
      </div>
    </div>
  )
}

// ─── SVG rendering with zoom/pan ────────────────────────────────────────────

function GraphSvg({
  nodes, edges, onSelect, selectedId,
}: {
  nodes: LayoutNode[]; edges: [number, number][]
  onSelect: (node: LayoutNode | null) => void; selectedId: number | null
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  const contentW = nodes.length > 0 ? Math.max(...nodes.map(n => n.x + n.w)) + PADDING : 400
  const contentH = nodes.length > 0 ? Math.max(...nodes.map(n => n.y + n.h)) + PADDING : 200

  // Zoom/pan handlers.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(z => Math.max(0.2, Math.min(3, z * delta)))
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }, [pan])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }, [dragging])

  const onMouseUp = useCallback(() => setDragging(false), [])

  // Reset view on double-click.
  const onDblClick = useCallback(() => {
    setZoom(1); setPan({ x: 0, y: 0 }); onSelect(null)
  }, [onSelect])

  const connectedEdges = useMemo(() => {
    if (hovered === null && selectedId === null) return new Set<number>()
    const target = hovered ?? selectedId
    const s = new Set<number>()
    edges.forEach(([from, to], i) => { if (from === target || to === target) s.add(i) })
    return s
  }, [hovered, selectedId, edges])

  const dimmed = hovered !== null || selectedId !== null

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      className={css.planGraphSvg}
      viewBox={`0 0 ${contentW} ${contentH}`}
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={onDblClick}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
    >
      <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
        {/* Background grid */}
        <defs>
          <pattern id="pg-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#2a2a4e" strokeWidth="0.4" opacity="0.6" />
          </pattern>
          <marker id="pg-arrow" viewBox="0 0 12 8" refX="11" refY="4" markerWidth="10" markerHeight="7" orient="auto">
            <path d="M0,1 L10,4 L0,7 L2,4 Z" fill="#8888cc" />
          </marker>
          <marker id="pg-arrow-hl" viewBox="0 0 12 8" refX="11" refY="4" markerWidth="10" markerHeight="7" orient="auto">
            <path d="M0,1 L10,4 L0,7 L2,4 Z" fill="#ffcc44" />
          </marker>
        </defs>
        <rect width={contentW} height={contentH} fill="url(#pg-grid)" />

        {/* Edges — rendered BEFORE nodes so nodes sit on top */}
        {edges.map(([from, to], i) => {
          const a = byId.get(from)
          const b = byId.get(to)
          if (!a || !b) return null
          const x1 = a.x + a.w; const y1 = a.y + a.h / 2
          const x2 = b.x; const y2 = b.y + b.h / 2
          const mx = (x1 + x2) / 2
          const active = connectedEdges.has(i)
          return (
            <path
              key={`e${i}`}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
              stroke={active ? '#ffcc44' : '#8888cc'}
              strokeWidth={active ? 3 : 2}
              strokeOpacity={dimmed && !active ? 0.3 : 1}
              markerEnd={active ? 'url(#pg-arrow-hl)' : 'url(#pg-arrow)'}
              style={{ transition: 'stroke-opacity 0.15s, stroke 0.15s' }}
            />
          )
        })}

        {/* Nodes */}
        {nodes.map(n => {
          const st = STATUS_THEME[n.status]
          const label = `${ticketNum(n.ticket.file)} · ${n.ticket.title}`
          const isHovered = hovered === n.id
          const isSelected = selectedId === n.id
          const active = isHovered || isSelected
          return (
            <g
              key={n.id}
              onMouseEnter={() => setHovered(n.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={(e) => { e.stopPropagation(); onSelect(isSelected ? null : n) }}
              style={{ cursor: 'pointer' }}
            >
              {/* Card */}
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="8"
                fill={st.bg}
                stroke={active ? st.stripe : st.stroke}
                strokeWidth={active ? 2 : 1}
                opacity={dimmed && !active ? 0.4 : 1}
                style={{ transition: 'opacity 0.15s, stroke 0.15s, stroke-width 0.15s' }}
              />
              {/* Left stripe */}
              <rect x={n.x} y={n.y} width={5} height={n.h} rx="8" ry="8" fill={st.stripe} />
              <rect x={n.x + 3} y={n.y} width={2} height={n.h} fill={st.stripe} />
              {/* Type badge — right-aligned, vertically centered */}
              {n.ticket.type && (
                <>
                  <rect x={n.x + n.w - 54} y={n.y + (n.h - 20) / 2} width={46} height={20} rx="4"
                    fill={TYPE_COLORS[n.ticket.type] ?? '#888'} opacity="0.2" />
                  <text x={n.x + n.w - 31} y={n.y + n.h / 2 + 1}
                    fill={TYPE_COLORS[n.ticket.type] ?? '#888'}
                    fontSize="10" fontWeight="600" textAnchor="middle" dominantBaseline="middle">
                    {n.ticket.type}
                  </text>
                </>
              )}
              {/* Label — left-aligned, vertically centered */}
              <text x={n.x + 15} y={n.y + n.h / 2 + 1}
                fill={st.text} fontSize="13" fontWeight="500" dominantBaseline="middle">
                {label.length > 22 ? label.slice(0, 21) + '…' : label}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function PlanGraphView({ tickets }: { tickets: GraphTicket[] }) {
  const { nodes, edges } = useMemo(() => layoutGraph(tickets), [tickets])
  const [selected, setSelected] = useState<LayoutNode | null>(null)

  if (tickets.length === 0) {
    return <div className={css.browserStart}>{t('wayfinderListEmpty')}</div>
  }

  return (
    <div className={css.planGraphContainer}>
      <GraphSvg nodes={nodes} edges={edges} onSelect={setSelected} selectedId={selected?.id ?? null} />
      {selected && <DetailPanel node={selected} onClose={() => setSelected(null)} />}
      <div className={css.planGraphLegend}>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_resolved}`} /> resolved</span>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_claimed}`} /> claimed</span>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_open}`} /> open</span>
        <span className={css.planGraphLegendItem}><span className={`${css.wayfinderStatusDot} ${css.wayfinderStatus_out_of_scope}`} /> out of scope</span>
        <span className={css.planGraphLegendItem} style={{ marginLeft: 8 }}>→ blocked_by</span>
        <span className={css.planGraphLegendItem} style={{ marginLeft: 8, opacity: 0.6 }}>滚轮缩放 · 拖拽平移 · 点击选中 · 双击重置</span>
      </div>
    </div>
  )
}

export type { GraphTicket }
