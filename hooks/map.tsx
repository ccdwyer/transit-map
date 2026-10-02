// The map itself: a Client surface module. It lays the graph out, animates the
// train and new stations on the surface's frame clock, pans with keys or a drag,
// and posts the selected station to the hooks module. No `$` here.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

import type { Detail, Graph } from '../types'
import { ago, layoutGraph, rowRuns } from './metro'
import type { MapLayout, Station } from './metro'

export type MapProps = { graph: Graph | null; detail: Detail | null }

type View = {
  seq: number
  layout: MapLayout | null
  known: Set<string>
  pops: Map<string, number>
  offX: number
  offY: number
  follow: boolean
  // Selection and hover by commit, so a refresh that shifts the stations keeps the same commits.
  selSha: string | null
  hoverSha: string | null
  sel: number
  hover: number
  train: { x: number; y: number }
  target: { x: number; y: number } | null
  drag: { x: number; offX: number; moved: boolean } | null
  ready: boolean
}

const FRAME_MS = 33
const POP_FRAMES = 10
const PAN_STEP = 8
const FOOTER_ROWS = 3

function fresh(): View {
  return {
    seq: -1,
    layout: null,
    known: new Set(),
    pops: new Map(),
    offX: 0,
    offY: 0,
    follow: true,
    selSha: null,
    hoverSha: null,
    sel: -1,
    hover: -1,
    train: { x: 0, y: 0 },
    target: null,
    drag: null,
    ready: false,
  }
}

/** How far right anything is drawn: tracks, labels, and the train with its cars. */
function contentWidth(v: View, cars: number): number {
  if (v.layout === null) return 0
  let right = v.layout.cols
  for (const l of v.layout.labels) right = Math.max(right, l.x + l.text.length + 1)
  if (v.layout.train !== null) right = Math.max(right, v.layout.train.x + 4 + cars)
  return right
}

function clampX(v: View, width: number, cars: number): void {
  v.offX = Math.max(0, Math.min(Math.max(0, contentWidth(v, cars) - width + 2), v.offX))
}

/** Keeps row `y` inside the visible rows. */
function showRow(v: View, y: number, rows: number): void {
  if (y < v.offY) v.offY = Math.max(0, y - 1)
  else if (y >= v.offY + rows) v.offY = Math.max(0, y - rows + 2)
}

function followHead(v: View, width: number, rows: number, cars: number): void {
  if (v.layout === null) return
  const anchor = v.target?.x ?? v.layout.cols
  v.offX = anchor - Math.floor(width * 0.7)
  clampX(v, width, cars)
  if (v.target !== null) showRow(v, Math.round(v.target.y), rows)
}

function nearest(v: View, x: number, y: number): number {
  if (v.layout === null) return -1
  let best = -1
  let bestDistance = 3
  v.layout.stations.forEach((s, i) => {
    const d = Math.abs(s.x - x) + Math.abs(s.y - y) * 2
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  })
  return best
}

// Stations left to right, so up and down walk time.
function stepSelection(v: View, by: number): number {
  if (v.layout === null || v.layout.stations.length === 0) return -1
  const order = [...v.layout.stations.keys()].sort((a, b) => (v.layout?.stations[a]?.x ?? 0) - (v.layout?.stations[b]?.x ?? 0))
  const at = order.indexOf(v.sel)
  const next = at === -1 ? order.length - 1 : Math.max(0, Math.min(order.length - 1, at + by))
  return order[next] ?? -1
}

function stationOf(v: View, i: number): Station | undefined {
  return i < 0 ? undefined : v.layout?.stations[i]
}

const TransitMap: ClientModule<MapProps, View> = (props, surface: ClientSurface<View>) => {
  const { Box, Text } = surface.elements
  const isFirst = surface.state === undefined
  const v = surface.state ?? fresh()
  // The current size, read when it is needed: handlers outlive the call that set them up.
  const widthNow = () => Math.max(10, surface.columns)
  const rowsNow = () => Math.max(1, surface.rows - FOOTER_ROWS)
  const carsNow = () => props.graph?.cars.length ?? 0
  const width = widthNow()
  const mapRows = rowsNow()

  // Set up once per instance, while there is no state yet; the state object then carries the view.
  if (isFirst) {
    v.ready = true
    surface.every(FRAME_MS, () => {
      let moving = false
      if (v.target !== null) {
        const dx = v.target.x - v.train.x
        const dy = v.target.y - v.train.y
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
          v.train = { x: v.train.x + dx * 0.22, y: v.train.y + dy * 0.22 }
          moving = true
        } else if (v.train.x !== v.target.x || v.train.y !== v.target.y) {
          v.train = { ...v.target }
          moving = true
        }
      }
      for (const [sha, left] of v.pops) {
        if (left <= 1) v.pops.delete(sha)
        else v.pops.set(sha, left - 1)
        moving = true
      }
      if (moving) surface.setState(v)
    })
    surface.onKey((e: ClientKeyEvent) => {
      const w = widthNow()
      if (e.key === 'left') {
        v.follow = false
        v.offX = Math.max(0, v.offX - PAN_STEP)
      } else if (e.key === 'right') {
        v.follow = false
        v.offX += PAN_STEP
        clampX(v, w, carsNow())
      } else if (e.key === 'pageup') {
        v.offY = Math.max(0, v.offY - 2)
      } else if (e.key === 'pagedown') {
        v.offY = Math.min(Math.max(0, (v.layout?.rows ?? 0) - rowsNow()), v.offY + 2)
      } else if (e.key === 'home') {
        v.follow = false
        v.offX = 0
      } else if (e.key === 'end' || e.key === 'f') {
        v.follow = true
        followHead(v, w, rowsNow(), carsNow())
      } else if (e.key === 'up' || e.key === 'down') {
        v.sel = stepSelection(v, e.key === 'down' ? -1 : 1)
        const s = stationOf(v, v.sel)
        if (s !== undefined) {
          v.selSha = s.sha
          if (s.x < v.offX + 2 || s.x > v.offX + w - 4) v.offX = Math.max(0, s.x - Math.floor(w / 2))
          showRow(v, s.y, rowsNow())
          v.follow = false
          surface.post({ select: s.sha })
        }
      } else if (e.key === 'return') {
        const s = stationOf(v, v.sel)
        if (s !== undefined) surface.post({ select: s.sha })
      } else {
        return
      }
      surface.setState(v)
    })
    surface.onPointer((e: ClientPointerEvent) => {
      if (e.type === 'down') {
        v.drag = { x: e.x, offX: v.offX, moved: false }
      } else if (e.type === 'move' && e.button !== undefined && v.drag !== null) {
        const shift = v.drag.x - e.x
        if (shift !== 0) {
          v.drag.moved = true
          v.follow = false
          v.offX = v.drag.offX + shift
          clampX(v, widthNow(), carsNow())
        }
      } else if (e.type === 'up') {
        const clicked = v.drag !== null && !v.drag.moved
        v.drag = null
        if (clicked) {
          v.sel = nearest(v, e.x + v.offX, e.y + v.offY)
          const s = stationOf(v, v.sel)
          v.selSha = s?.sha ?? null
          if (s !== undefined) surface.post({ select: s.sha })
        }
      } else if (e.type === 'move') {
        const over = nearest(v, e.x + v.offX, e.y + v.offY)
        if (over === v.hover) return
        v.hover = over
        v.hoverSha = stationOf(v, over)?.sha ?? null
      } else {
        return
      }
      surface.setState(v)
    })
  }

  // A new refresh: lay out again, pop in new stations, move the train.
  const graph = props.graph
  if (graph !== null && graph.seq !== v.seq) {
    const first = v.seq === -1
    v.seq = graph.seq
    v.layout = layoutGraph(graph)
    for (const c of graph.commits) {
      if (!first && !v.known.has(c.sha)) v.pops.set(c.sha, POP_FRAMES)
      v.known.add(c.sha)
    }
    const t = v.layout.train
    v.target = t === null ? null : { x: t.x, y: t.y }
    if (first && t !== null) v.train = { x: t.x, y: t.y }
    if (v.follow) followHead(v, width, mapRows, graph.cars.length)
    // The same commits stay selected and hovered; ones that left the map are let go.
    const indexOf = (sha: string | null) => (sha === null ? -1 : v.layout?.stations.findIndex(s => s.sha === sha) ?? -1)
    v.sel = indexOf(v.selSha)
    if (v.sel < 0) v.selSha = null
    v.hover = indexOf(v.hoverSha)
    if (v.hover < 0) v.hoverSha = null
  }
  // Record the view once, on the first call: later calls reuse this same state object.
  if (isFirst) surface.setState(v)

  if (graph === null || v.layout === null) {
    return <Box><Text dimColor>No map yet. Press Enter in the prompt with /metro to load it.</Text></Box>
  }
  const layout = v.layout

  // Overlays per row: new stations popping in, the train, the selection.
  const overlays = new Map<number, Map<number, { c: string; color: string; bold?: boolean; inverse?: boolean }>>()
  const at = (y: number) => {
    let row = overlays.get(y)
    if (row === undefined) {
      row = new Map()
      overlays.set(y, row)
    }
    return row
  }
  for (const s of layout.stations) {
    const left = v.pops.get(s.sha)
    if (left !== undefined) at(s.y).set(s.x, { c: left > POP_FRAMES / 2 ? '·' : '∘', color: '#FFFFFF', bold: true })
  }
  const train = layout.train
  if (train !== null) {
    const tx = Math.round(v.train.x)
    const ty = Math.round(v.train.y)
    const row = at(ty)
    for (let k = 0; k < 3; k += 1) row.set(tx + k, { c: '▶', color: '#FFFFFF', bold: true })
    // One car per uncommitted file (the props carry up to 60); pan right to see a long train.
    graph.cars.forEach((car, k) => row.set(tx + 3 + k, { c: '▮', color: car.lit ? '#FCCC0A' : train.color, bold: car.lit }))
  }
  for (const label of layout.labels) {
    // The current line's name rides behind the train.
    const shift = train !== null && label.y === train.y && label.x === train.x ? 4 + graph.cars.length : 0
    const row = at(label.y)
    for (let k = 0; k < label.text.length; k += 1) {
      const x = label.x + shift + k
      if (!row.has(x)) row.set(x, { c: label.text[k] ?? ' ', color: label.color, bold: true })
    }
  }
  const selected = stationOf(v, v.sel)
  if (selected !== undefined) {
    const row = at(selected.y)
    const cell = selected.y * layout.cols + selected.x
    row.set(selected.x, { c: layout.ch[cell] ?? '○', color: layout.fg[cell] ?? '#FFFFFF', bold: true, inverse: true })
  }

  const body: RenderElement[] = []
  // A window of rows from offY: lower lines scroll into view (PgUp/PgDn, or by selecting a station).
  v.offY = Math.max(0, Math.min(v.offY, Math.max(0, layout.rows + 1 - mapRows)))
  for (let y = v.offY; y < Math.min(v.offY + mapRows, layout.rows + 1); y += 1) {
    const runs = rowRuns(layout, y, v.offX, width, overlays.get(y) ?? new Map())
    body.push(
      <Box key={`r${y}`} flexDirection="row">
        {runs.map((run, k) => (
          <Text key={`c${k}`} color={run.color ?? undefined} bold={run.bold} inverse={run.inverse}>{run.text}</Text>
        ))}
      </Box>,
    )
  }

  // Footer: the station under the pointer or selected, then the line legend.
  const focus = stationOf(v, v.hover) ?? selected
  const commit = focus === undefined ? undefined : graph.commits[focus.idx]
  const detail = props.detail !== null && commit !== undefined && props.detail.sha === commit.sha ? props.detail : null
  const info = commit === undefined
    ? '↑↓ stations · ←→ pan · PgUp/PgDn lines · drag to pan · click a station · f follow the train'
    : `${commit.sha.slice(0, 8)} ${commit.subject} — ${commit.author}, ${ago(commit.time, Date.now())}`
  const files = detail === null ? '' : detail.files.length === 0 ? 'no files' : `files: ${detail.files.slice(0, 8).join(', ')}${detail.files.length > 8 ? ` +${detail.files.length - 8}` : ''}`
  const legend = layout.lanes.filter(l => !l.name.startsWith('·')).slice(0, 8)

  return (
    <Box flexDirection="column">
      {body}
      <Text wrap="truncate-end" bold={commit !== undefined}>{info}</Text>
      <Text wrap="truncate-end" dimColor>{files === '' ? ' ' : files}</Text>
      <Box flexDirection="row">
        {legend.map(lane => (
          <Text key={`l${lane.name}`} color={lane.color}>{`${lane.dashed ? '╍╍' : '━━'} ${lane.name}  `}</Text>
        ))}
      </Box>
    </Box>
  )
}

export default TransitMap
