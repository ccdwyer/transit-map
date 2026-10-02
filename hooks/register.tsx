import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, Graph } from '../types'
import { LOG_FORMAT, MAX_COMMITS, paneRows, parseLog, parseStatus } from './metro'

const PANE = 'transit-map'
const graphAtom = atom({ plugin: 'transit-map', key: 'graph' } as const, null)
const detailAtom = atom({ plugin: 'transit-map', key: 'detail' } as const, null)
const stripAtom = atom({ plugin: 'transit-map', key: 'strip' } as const, false)
const litAtom = atom({ plugin: 'transit-map', key: 'lit' } as const, [])
const errorAtom = atom({ plugin: 'transit-map', key: 'error' } as const, null)

const GIT_TIMEOUT = 5000
// Git commands that move the map: new stations, a moved train, other lines.
const MOVES_MAP = /\bgit\b[^|;&]*\b(commit|checkout|switch|merge|rebase|reset|pull|fetch|push|branch|tag|cherry-pick|revert|stash|am|restore)\b|\bgh\s+(pr\s+(merge|checkout)|stack)\b/
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])
// The cars handed to the map as props: enough for any train on screen, bounded so a huge dirty tree stays small.
const MAX_CARS = 60

let seq = 0
// While the pane is open inline, the body rows it last asked for: a map that gains lanes asks again.
let askedRows: number | null = null
// The height of the tree the pane drew last: an inline host reports min(granted, measured), so only a report
// smaller than what was drawn is a real, smaller window.
let lastPaneHeight = 0

type Run = { exitCode: number; stdout: string }

async function git($: EngineInterface, cwd: string, args: string[]): Promise<Run | null> {
  try {
    const out = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT })
    return { exitCode: out.exitCode, stdout: out.stdout }
  } catch {
    return null
  }
}

async function repoRoot($: EngineInterface): Promise<string | null> {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (top === null || top.exitCode !== 0) return null
  return top.stdout.trim() || null
}

// The whole map: history, HEAD, upstream and the working tree.
async function refresh($: EngineInterface): Promise<Graph | null> {
  const root = await repoRoot($)
  if (root === null) {
    await update($, errorAtom, () => 'Not inside a git repository.')
    return null
  }
  const head = await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])
  // A repository with no commits yet (HEAD does not resolve) is still a map: an empty one.
  const isEmpty = head !== null && head.exitCode !== 0
  const log = isEmpty ? null : await git($, root, ['log', '--all', '--topo-order', '--decorate=full', '-n', String(MAX_COMMITS + 1), `--format=${LOG_FORMAT}`])
  if (!isEmpty && (log === null || log.exitCode !== 0)) {
    await update($, errorAtom, () => 'git log failed.')
    return null
  }
  const parsed = parseLog(log?.exitCode === 0 ? log.stdout : '')
  const headSha = head !== null && head.exitCode === 0 ? head.stdout.trim() : ''
  if (headSha !== '' && !parsed.commits.some(c => c.sha === headSha)) {
    // HEAD is older than the newest stations (a checkout of an old commit): bring its own history in too.
    const own = await git($, root, ['log', '--topo-order', '--decorate=full', '-n', '30', `--format=${LOG_FORMAT}`, 'HEAD'])
    if (own !== null && own.exitCode === 0) {
      const have = new Set(parsed.commits.map(c => c.sha))
      const extra = parseLog(own.stdout).commits.filter(c => !have.has(c.sha))
      parsed.commits = [...parsed.commits.slice(0, Math.max(0, MAX_COMMITS - extra.length)), ...extra]
      parsed.truncated = true
    }
  }
  const branch = await git($, root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const upstream = await git($, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  let ahead = 0
  let behind = 0
  const hasUpstream = upstream !== null && upstream.exitCode === 0
  if (hasUpstream) {
    const counts = await git($, root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
    const [a, b] = (counts?.stdout ?? '').trim().split(/\s+/)
    ahead = Number(a) || 0
    behind = Number(b) || 0
  }
  const status = await git($, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const lit = await read($, litAtom)
  seq += 1
  const graph: Graph = {
    seq: Date.now() * 10 + (seq % 10),
    repo: root.slice(root.lastIndexOf('/') + 1),
    root,
    commits: parsed.commits,
    truncated: parsed.truncated,
    head: head !== null && head.exitCode === 0 ? head.stdout.trim() || null : null,
    branch: branch !== null && branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    upstream: hasUpstream ? (upstream?.stdout.trim() ?? null) : null,
    ahead,
    behind,
    cars: status !== null && status.exitCode === 0 ? parseStatus(status.stdout, lit, root).slice(0, MAX_CARS) : [],
  }
  await update($, graphAtom, () => graph)
  await update($, errorAtom, () => null)
  await growPane($, graph)
  return graph
}

/** The pane is open and the map gained lanes: ask for the rows they need. A closed pane stays closed. */
async function growPane($: EngineInterface, graph: Graph): Promise<void> {
  try {
    const want = paneRows(graph)
    if (askedRows === null) {
      // After a reload the module forgot what it asked for; a pane still on screen is still open.
      const panes = await $.ui.panes()
      const open = panes.some(p => p.id === PANE && p.isPlaced)
      if (!open) return
      askedRows = want
      return
    }
    if (want <= askedRows) return
    const opened = await $.ui.open({ id: PANE, title: `Transit Map · ${graph.repo}`, rows: want })
    if (opened.isPlaced) askedRows = want
  } catch {
    // The map keeps its size; lower lanes still page into view.
  }
}

// Only the train: the working tree changed, history did not.
async function refreshCars($: EngineInterface): Promise<void> {
  const current = await read($, graphAtom)
  if (current === null) return
  const root = await repoRoot($)
  if (root === null) return
  // Another checkout now: this history is not its history, so redraw the whole map.
  if (root !== current.root) {
    await refresh($)
    return
  }
  const status = await git($, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status === null || status.exitCode !== 0) return
  const lit = await read($, litAtom)
  const cars = parseStatus(status.stdout, lit, root).slice(0, MAX_CARS)
  seq += 1
  await update($, graphAtom, g => (g === null ? g : { ...g, cars, seq: Date.now() * 10 + (seq % 10) }))
}

async function showDetail($: EngineInterface, sha: string): Promise<void> {
  const current = await read($, graphAtom)
  if (current === null || !current.commits.some(c => c.sha === sha)) return
  const root = await repoRoot($)
  if (root === null) return
  const out = await git($, root, ['show', '--no-color', '--name-only', '--format=%an%x1f%ci%x1f%s', sha])
  if (out === null || out.exitCode !== 0) return
  const [first, ...rest] = out.stdout.split('\n')
  const [author, date, subject] = (first ?? '').split('\x1f')
  const detail: Detail = {
    sha,
    author: author ?? '',
    date: date ?? '',
    subject: subject ?? '',
    files: rest.map(f => f.trim()).filter(f => f !== '').slice(0, 40),
  }
  await update($, detailAtom, () => detail)
}

function editedPath(e: { tool: string; [k: string]: unknown }): string | null {
  const path = e.file_path ?? e.notebook_path
  return typeof path === 'string' ? path : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'metro',
      description: 'Transit Map: your git history as a subway map (/metro strip on|off for the line above the prompt)',
      argumentHint: '[strip on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'metro' }, async ($, e) => {
    const args = String(e.args ?? '').trim()
    if (/^strip\s+(on|off)$/.test(args)) {
      const enabled = args.endsWith('on')
      await update($, stripAtom, () => enabled)
      return { text: `Transit Map: the strip above the prompt is ${enabled ? 'on' : 'off'}.` }
    }
    const graph = await refresh($)
    if (graph === null) {
      const why = await read($, errorAtom)
      return { text: `Transit Map: ${why ?? 'could not read git history.'}` }
    }
    await update($, stripAtom, () => true)
    // Inline, ask for every lane at once: left to a third of the screen, side lines clip to stubs.
    const want = paneRows(graph)
    askedRows = null
    const opened = await $.ui.open({ id: PANE, title: `Transit Map · ${graph.repo}`, rows: want })
    askedRows = opened.isPlaced ? want : null
    const lines = new Set(graph.commits.flatMap(c => [...c.refs, ...c.remotes])).size
    return { text: `Transit Map: ${graph.commits.length} stations on ${lines} line${lines === 1 ? '' : 's'}${graph.truncated ? ' (newest only)' : ''}.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined) return ran
    try {
      if ((await read($, graphAtom)) === null) return ran
      if (e.tool === 'Bash' && MOVES_MAP.test(String(e.command))) {
        await refresh($)
      } else if (EDITS.has(e.tool) && ran.isError !== true) {
        const path = editedPath(e as { tool: string })
        if (path !== null) await update($, litAtom, list => [...list.filter(p => p !== path), path].slice(-50))
        await refreshCars($)
      } else if (e.tool === 'Bash' && ran.isError !== true && ran.isReadOnly !== true) {
        // Shell edits (sed -i, codegen) change the train's cars too; read-only commands (ls, rg) do not.
        await refreshCars($)
      }
    } catch {
      // The map is decoration: never fail a tool call over it.
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    try {
      // Once per main-loop turn, the whole map: commits a subagent or an unrecognized command made appear here.
      if (e.agentId === undefined && (await read($, graphAtom)) !== null) await refresh($)
    } catch {
      // ignore
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    askedRows = null
    lastPaneHeight = 0
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { select?: unknown } | null
    if (e.element === 'metro' && data !== null && typeof data === 'object' && typeof data.select === 'string') {
      await showDetail($, data.select)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const graph = await read($, graphAtom)
    const detail = await read($, detailAtom)
    const error = await read($, errorAtom)
    const where = graph === null
      ? ''
      : `${graph.branch ?? 'detached HEAD'}${graph.upstream === null ? '' : ` → ${graph.upstream}`}${graph.ahead > 0 ? ` ↑${graph.ahead}` : ''}${graph.behind > 0 ? ` ↓${graph.behind}` : ''}`
    const header = (
      <Box key="hdr" flexDirection="row" overflow="hidden">
        <Text color="#EE352E" bold>{'Ⓜ TRANSIT MAP '}</Text>
        <Text color="#FFFFFF" bold>{graph?.repo ?? ''}</Text>
        <Text dimColor>{graph === null ? ` ${error ?? 'loading…'}` : `  ${where} · ${graph.cars.length} car${graph.cars.length === 1 ? '' : 's'} on the train`}</Text>
      </Box>
    )
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      // No Client here: a timetable of the newest stations instead.
      return (
        <Box flexDirection="column">
          {header}
          {(graph?.commits ?? []).slice(0, 15).map(c => (
            <Text key={`t${c.sha}`}>{`${c.sha === graph?.head ? '●' : c.parents.length > 1 ? '◎' : '○'} ${c.sha.slice(0, 7)} ${[...c.refs, ...c.tags.map(t => `⚑${t}`)].join(' ')} ${c.subject}`}</Text>
          ))}
        </Box>
      )
    }
    const { Client } = $.ui.resolve(e)
    const given = e.props.scroll?.bodyRows ?? 0
    // Inline, lay out to the height asked for (the host may report the body it measured, not the rows it granted);
    // a smaller real window (the person dragged the block down) wins. Docked, the body is the real allocation.
    const asked = askedRows ?? (graph === null ? 9 : paneRows(graph))
    const body = e.props.placement === 'inline'
      ? (given > 0 && given < lastPaneHeight ? given : asked)
      : given > 0 ? given : e.viewport?.rows ?? 24
    // The header takes one row; the Client gets the rest, never more than the body.
    const rows = Math.max(1, body - 1)
    lastPaneHeight = 1 + rows
    return (
      <Box flexDirection="column">
        {header}
        <Client key="metro" module="./map.tsx" props={{ graph, detail }} width="100%" height={rows} />
      </Box>
    )
  })

  // One row above the prompt, once the map has been opened: the line you are on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const strip = await read($, stripAtom)
    const graph = await read($, graphAtom)
    if (!strip || graph === null || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const lit = graph.cars.filter(c => c.lit).length
    const shown = graph.cars.slice(0, 8)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="#EE352E" bold>{'Ⓜ '}</Text>
          <Text bold>{graph.branch ?? 'detached'}</Text>
          <Text dimColor>{' ━━○━━○━━● '}</Text>
          <Text color="#FFFFFF" bold>{'▶▶▶'}</Text>
          {shown.map((car, k) => (
            <Text key={`car${k}`} color={car.lit ? '#FCCC0A' : '#A7A9AC'}>{'▮'}</Text>
          ))}
          <Text dimColor>{`  ${graph.cars.length} uncommitted${lit > 0 ? `, ${lit} edited by Claude` : ''}${graph.ahead > 0 ? ` · ↑${graph.ahead}` : ''}${graph.behind > 0 ? ` · ↓${graph.behind}` : ''} · /metro`}</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
