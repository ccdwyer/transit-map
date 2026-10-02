// Pure parsing and layout for the transit map. No `$` here: the hooks module
// runs git, this file turns its output into a map both the hooks module and the
// Client surface module draw from.

import type { Car, Commit, Graph } from '../types'

export const FIELD = '\x1f'
export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ct%x1f%D%x1f%s'
export const MAX_COMMITS = 120
export const MAX_LANES = 10
const SPACING = 3
const SUBJECT_ROOM = 72

// Vignelli-era subway colours. Trunk branches are always red.
const TRUNK_COLOR = '#EE352E'
const PALETTE = ['#0039A6', '#FF6319', '#00933C', '#FCCC0A', '#B933AD', '#00ADD0', '#6CBE45', '#996633', '#F4A6C8']
const REMOTE_COLOR = '#A7A9AC'
const MERGED_COLOR = '#808183'
const TRUNKS = ['main', 'master', 'trunk', 'develop']

export function parseLog(stdout: string): { commits: Commit[]; truncated: boolean } {
  const commits: Commit[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.trim() === '') continue
    const parts = raw.split(FIELD)
    if (parts.length < 6) continue
    const [sha, parentText, author, time, decorations] = parts
    const subject = parts.slice(5).join(FIELD)
    const commit: Commit = {
      sha: sha ?? '',
      parents: (parentText ?? '').split(' ').filter(p => p !== ''),
      author: (author ?? '').slice(0, 40),
      time: Number(time) || 0,
      subject: subject.length > SUBJECT_ROOM ? `${subject.slice(0, SUBJECT_ROOM - 1)}…` : subject,
      refs: [],
      remotes: [],
      tags: [],
    }
    for (const piece of (decorations ?? '').split(', ')) {
      const ref = piece.startsWith('HEAD -> ') ? piece.slice(8) : piece
      if (ref.startsWith('refs/heads/')) commit.refs.push(ref.slice(11))
      else if (ref.startsWith('tag: refs/tags/')) commit.tags.push(ref.slice(15))
      else if (ref.startsWith('refs/tags/')) commit.tags.push(ref.slice(10))
      else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) commit.remotes.push(ref.slice(13))
    }
    if (commit.sha !== '') commits.push(commit)
  }
  return { commits: commits.slice(0, MAX_COMMITS), truncated: commits.length > MAX_COMMITS }
}

// `git status --porcelain=v1 -z`: "XY path\0", a rename or copy followed by its old path.
export function parseStatus(stdout: string, lit: readonly string[], root = ''): Car[] {
  const cars: Car[] = []
  const entries = stdout.split('\0')
  // Edited paths as the tools named them (usually absolute), made relative to the repo root.
  const prefix = root === '' ? '' : `${root.replace(/\/+$/, '')}/`
  const edited = new Set(lit.map(p => (prefix !== '' && p.startsWith(prefix) ? p.slice(prefix.length) : p)))
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? ''
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    // A rename or copy (in either column) is followed by its old path, which is not a change of its own.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') i += 1
    const path = entry.slice(3)
    cars.push({ path, code: code.trim() || code, lit: edited.has(path) })
  }
  return cars
}

export type Lane = { name: string; color: string; dashed: boolean }
export type Station = { sha: string; idx: number; x: number; y: number; kind: 'commit' | 'merge' | 'tag' | 'head' }
export type Label = { x: number; y: number; text: string; color: string }

export type MapLayout = {
  cols: number
  rows: number
  ch: string[]
  fg: (string | null)[]
  bold: boolean[]
  stations: Station[]
  labels: Label[]
  lanes: Lane[]
  // Where the train's engine sits: one cell past the HEAD station, on its line.
  train: { x: number; y: number; color: string } | null
}

const isTrunk = (name: string) => TRUNKS.includes(name.replace(/^[^/]+\//, ''))

// Which branch each commit belongs to: walk first parents from each branch tip,
// trunk first, then the checked-out branch, then the rest by recency, then
// remote-only branches. Commits no tip reaches (merged, deleted branches) get
// one grey line per first-parent chain.
function assignBranches(graph: Graph): { owner: Map<string, string>; order: string[]; dashed: Set<string> } {
  const bySha = new Map(graph.commits.map(c => [c.sha, c]))
  const tips: { name: string; sha: string; rank: number; time: number; remote: boolean }[] = []
  const locals = new Set(graph.commits.flatMap(c => c.refs))
  for (const c of graph.commits) {
    for (const name of c.refs) {
      const rank = isTrunk(name) ? 0 : name === graph.branch ? 1 : 2
      tips.push({ name, sha: c.sha, rank, time: c.time, remote: false })
    }
    for (const name of c.remotes) {
      // A remote branch with a local counterpart shares its line (dashed past it).
      const local = name.replace(/^[^/]+\//, '')
      const line = locals.has(local) ? local : name
      tips.push({ name: line, sha: c.sha, rank: locals.has(local) ? (isTrunk(local) ? 0 : local === graph.branch ? 1 : 2) : 3, time: c.time, remote: true })
    }
  }
  tips.sort((a, b) => a.rank - b.rank || Number(a.remote) - Number(b.remote) || b.time - a.time)
  const owner = new Map<string, string>()
  const order: string[] = []
  const dashed = new Set<string>()
  const localReach = new Set<string>()
  // Everything a local branch reaches is solid; what only remotes reach is dashed.
  for (const tip of tips.filter(t => !t.remote)) {
    const stack = [tip.sha]
    while (stack.length > 0) {
      const sha = stack.pop() as string
      if (localReach.has(sha)) continue
      localReach.add(sha)
      for (const p of bySha.get(sha)?.parents ?? []) if (bySha.has(p)) stack.push(p)
    }
  }
  for (const tip of tips) {
    let sha: string | undefined = tip.sha
    let claimed = 0
    while (sha !== undefined && bySha.has(sha) && !owner.has(sha)) {
      owner.set(sha, tip.name)
      claimed += 1
      if (!localReach.has(sha)) dashed.add(sha)
      sha = bySha.get(sha)?.parents[0]
    }
    // A tip that owns nothing (a branch sharing another's tip, a merged remote) gets no lane of its own;
    // its name is drawn beside the station it points at instead.
    if (claimed > 0 && !order.includes(tip.name)) order.push(tip.name)
  }
  let merged = 0
  for (const c of graph.commits) {
    if (owner.has(c.sha)) continue
    const name = `·merged-${(merged += 1)}`
    let sha: string | undefined = c.sha
    while (sha !== undefined && bySha.has(sha) && !owner.has(sha)) {
      owner.set(sha, name)
      sha = bySha.get(sha)?.parents[0]
    }
    order.push(name)
  }
  return { owner, order, dashed }
}

function colorFor(name: string, used: number): string {
  if (name.startsWith('·merged')) return MERGED_COLOR
  if (isTrunk(name)) return TRUNK_COLOR
  return PALETTE[used % PALETTE.length] ?? REMOTE_COLOR
}

export function layoutGraph(graph: Graph): MapLayout {
  const n = graph.commits.length
  const { owner, order, dashed } = assignBranches(graph)
  const lanes: Lane[] = []
  const laneOf = new Map<string, number>()
  let colors = 0
  const remoteOnly = new Set(graph.commits.flatMap(c => c.remotes))
  const distinct = order.filter((name, i) => order.indexOf(name) === i)
  const overflow = Math.max(0, distinct.length - MAX_LANES)
  for (const name of distinct) {
    // Past the cap, the remaining lines share one grey "+N more lines" lane rather than another line's colour.
    if (overflow > 0 && lanes.length === MAX_LANES - 1) {
      lanes.push({ name: `+${overflow + 1} more lines`, color: MERGED_COLOR, dashed: true })
    }
    if (lanes.length >= MAX_LANES) {
      laneOf.set(name, MAX_LANES - 1)
      continue
    }
    const isRemote = remoteOnly.has(name) && !graph.commits.some(c => c.refs.includes(name))
    const color = isRemote ? REMOTE_COLOR : colorFor(name, isTrunk(name) || name.startsWith('·') ? colors : colors++)
    laneOf.set(name, lanes.length)
    lanes.push({ name, color, dashed: isRemote })
  }

  const cols = Math.max(1, n * SPACING + 2)
  const rows = Math.max(1, lanes.length * 2 + 1)
  const ch: string[] = new Array(cols * rows).fill(' ')
  const fg: (string | null)[] = new Array(cols * rows).fill(null)
  const bold: boolean[] = new Array(cols * rows).fill(false)
  const rank = new Array(cols * rows).fill(0)
  const put = (x: number, y: number, c: string, color: string, level: number, strong = false) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return
    const i = y * cols + x
    if (level < rank[i]) return
    ch[i] = c
    fg[i] = color
    bold[i] = strong
    rank[i] = level
  }

  const index = new Map(graph.commits.map((c, i) => [c.sha, i]))
  const xOf = (i: number) => (n - 1 - i) * SPACING + 1
  const yOf = (sha: string) => 1 + (laneOf.get(owner.get(sha) ?? '') ?? 0) * 2
  const laneColor = (sha: string) => lanes[laneOf.get(owner.get(sha) ?? '') ?? 0]?.color ?? MERGED_COLOR

  // Track lines: parent (left, older) to child (right, newer).
  graph.commits.forEach((c, ci) => {
    const xc = xOf(ci)
    const yc = yOf(c.sha)
    c.parents.forEach((p, pi) => {
      const pIndex = index.get(p)
      if (pIndex === undefined) {
        // The parent is past the cap: run the line off the left edge.
        for (let x = 0; x < xc; x += 1) put(x, yc, dashed.has(c.sha) ? '╍' : '━', laneColor(c.sha), 1)
        return
      }
      const xp = xOf(pIndex)
      const yp = yOf(p)
      const firstParent = pi === 0
      const color = firstParent ? laneColor(c.sha) : laneColor(p)
      const isDashed = firstParent ? dashed.has(c.sha) : dashed.has(p)
      const flat = isDashed ? '╍' : '━'
      if (yc === yp) {
        for (let x = xp + 1; x < xc; x += 1) put(x, yc, flat, color, 1)
        return
      }
      // Going rightwards the line climbs (╱) or drops (╲): 45° steps while there
      // is room, a straight drop (┃) when there is not.
      const step = yc < yp ? -1 : 1
      const diag = yc < yp ? '╱' : '╲'
      if (firstParent) {
        // Branch-off: leave the parent's line at once, then run along the child's.
        let x = xp
        let y = yp
        while (y !== yc) {
          const moved = x + 1 < xc
          if (moved) x += 1
          y += step
          // A step that also moved right is a diagonal; out of room, the line drops straight.
          if (y !== yc) put(x, y, moved ? diag : '┃', color, 2)
        }
        // The landing cell joins the diagonal to the child's line.
        for (let k = Math.max(x, xp + 1); k < xc; k += 1) put(k, yc, flat, color, 1)
      } else {
        // Merge: run along the parent's line, then arrive at the last moment.
        let x = xc
        let y = yc
        while (y !== yp) {
          const moved = x - 1 > xp
          if (moved) x -= 1
          y -= step
          if (y !== yp) put(x, y, moved ? diag : '┃', color, 2)
        }
        for (let k = xp + 1; k <= Math.min(x, xc - 1); k += 1) put(k, yp, flat, color, 1)
      }
    })
  })

  const stations: Station[] = []
  graph.commits.forEach((c, ci) => {
    const x = xOf(ci)
    const y = yOf(c.sha)
    const isHead = c.sha === graph.head
    const kind: Station['kind'] = isHead ? 'head' : c.tags.length > 0 ? 'tag' : c.parents.length > 1 ? 'merge' : 'commit'
    const glyph = kind === 'head' ? '●' : kind === 'tag' ? '▣' : kind === 'merge' ? '◎' : dashed.has(c.sha) ? '◌' : '○'
    put(x, y, glyph, kind === 'head' ? '#FFFFFF' : laneColor(c.sha), 3, kind !== 'commit')
    stations.push({ sha: c.sha, idx: ci, x, y, kind })
  })

  // Line names at each line's newest station; tags above their station.
  const labels: Label[] = []
  const seen = new Set<string>()
  graph.commits.forEach((c, ci) => {
    const name = owner.get(c.sha) ?? ''
    if (seen.has(name)) return
    seen.add(name)
    if (name.startsWith('·')) return
    const lane = lanes[laneOf.get(name) ?? 0]
    labels.push({ x: xOf(ci) + 2, y: yOf(c.sha), text: name, color: lane?.color ?? MERGED_COLOR })
  })
  graph.commits.forEach((c, ci) => {
    if (c.tags.length > 0) labels.push({ x: xOf(ci) - 1, y: yOf(c.sha) - 1, text: `⚑${c.tags[0]}`, color: '#FCCC0A' })
    // Branches that share this station without a line of their own (just created, or fast-forwarded).
    const sharing = c.refs.filter(r => !laneOf.has(r))
    if (sharing.length > 0) labels.push({ x: xOf(ci) + 2, y: yOf(c.sha) + 1, text: `↳ ${sharing.join(' · ')}`, color: '#FFFFFF' })
  })

  const headIndex = graph.head === null ? undefined : index.get(graph.head)
  const train = headIndex === undefined || graph.head === null
    ? null
    : { x: xOf(headIndex) + 2, y: yOf(graph.head), color: laneColor(graph.head) }

  return { cols, rows, ch, fg, bold, stations, labels, lanes, train }
}

export type Run = { text: string; color: string | null; bold: boolean; inverse: boolean }

// One visible row of the map as runs of same-styled text, `from` the pan offset.
export function rowRuns(
  layout: MapLayout,
  y: number,
  from: number,
  width: number,
  overlay: Map<number, { c: string; color: string; bold?: boolean; inverse?: boolean }>,
): Run[] {
  const runs: Run[] = []
  for (let x = from; x < from + width; x += 1) {
    const inside = x >= 0 && x < layout.cols && y >= 0 && y < layout.rows
    const i = y * layout.cols + x
    const top = overlay.get(x)
    const c = top?.c ?? (inside ? layout.ch[i] ?? ' ' : ' ')
    const color = top?.color ?? (inside ? layout.fg[i] ?? null : null)
    const strong = top?.bold ?? (inside ? layout.bold[i] ?? false : false)
    const inverse = top?.inverse ?? false
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color && last.bold === strong && last.inverse === inverse) last.text += c
    else runs.push({ text: c, color, bold: strong, inverse })
  }
  return runs
}

export function ago(seconds: number, now: number): string {
  const s = Math.max(0, Math.round(now / 1000 - seconds))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
