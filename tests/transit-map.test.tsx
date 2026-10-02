import { describe, expect, test } from 'claude-code/testing'

import type { Graph } from '../types'
import { layoutGraph, parseLog, parseStatus, rowRuns } from '../hooks/metro'

const F = '\x1f'
const line = (sha: string, parents: string, decorations: string, subject: string, time = 1_700_000_000) =>
  [sha, parents, 'Ada', String(time), decorations, subject].join(F)

// main ← b1 ← f1 (feature, checked out), main merged an old branch, a tag on the base,
// and origin/spike exists only on the remote.
const LOG = [
  line('f2', 'f1', 'HEAD -> refs/heads/feature, refs/remotes/origin/feature', 'Feature part two', 1_700_000_500),
  line('s1', 'm2', 'refs/remotes/origin/spike', 'Spike on the remote', 1_700_000_400),
  line('m3', 'm2 x1', 'refs/heads/main, refs/remotes/origin/main', 'Merge branch old', 1_700_000_300),
  line('x1', 'm1', '', 'Old branch work', 1_700_000_250),
  line('f1', 'm2', '', 'Feature part one', 1_700_000_200),
  line('m2', 'm1', '', 'Second', 1_700_000_100),
  line('m1', '', 'tag: refs/tags/v1.0', 'Base', 1_700_000_000),
].join('\n')

const STATUS = ' M src/app.ts\0?? notes.md\0R  new.ts\0old.ts\0'

function graphOf(): Graph {
  const { commits, truncated } = parseLog(LOG)
  return {
    seq: 1, repo: 'demo', root: '/p', commits, truncated, head: 'f2', branch: 'feature',
    upstream: 'origin/feature', ahead: 1, behind: 0, cars: parseStatus(STATUS, ['/p/src/app.ts'], '/p'),
  }
}

describe('parsing', () => {
  test('log decorations become branches, remotes and tags', () => {
    const { commits } = parseLog(LOG)
    expect(commits.length).toBe(7)
    expect(commits[0]?.refs).toEqual(['feature'])
    expect(commits[0]?.remotes).toEqual(['origin/feature'])
    expect(commits[2]?.parents).toEqual(['m2', 'x1'])
    expect(commits[6]?.tags).toEqual(['v1.0'])
  })

  test('status becomes train cars, renames counted once, edited files lit', () => {
    const cars = parseStatus(STATUS, ['/p/src/app.ts'], '/p')
    expect(cars.map(c => c.path)).toEqual(['src/app.ts', 'notes.md', 'new.ts'])
    expect(cars[0]?.lit).toBe(true)
    expect(cars[1]?.lit).toBe(false)
  })

  test('a rename in the second column also consumes its old path', () => {
    const cars = parseStatus(' R new.ts\0old.ts\0 M a.ts\0', [], '/p')
    expect(cars.map(c => c.path)).toEqual(['new.ts', 'a.ts'])
  })

  test('an edited file lights only its own car, never one that merely ends the same way', () => {
    const cars = parseStatus(' M app.ts\0 M other/src/app.ts\0 M src/app.ts\0', ['/p/src/app.ts'], '/p')
    expect(cars.map(c => c.lit)).toEqual([false, false, true])
  })
})

describe('layout', () => {
  test('trunk first and red, the checked-out branch next, remote-only lines dashed', () => {
    const map = layoutGraph(graphOf())
    expect(map.lanes[0]?.name).toBe('main')
    expect(map.lanes[0]?.color).toBe('#EE352E')
    expect(map.lanes[1]?.name).toBe('feature')
    const spike = map.lanes.find(l => l.name === 'origin/spike')
    expect(spike?.dashed).toBe(true)
  })

  test('stations: HEAD, merge interchange, tag terminus, train past HEAD', () => {
    const map = layoutGraph(graphOf())
    const kinds = Object.fromEntries(map.stations.map(s => [s.sha, s.kind]))
    expect(kinds.f2).toBe('head')
    expect(kinds.m3).toBe('merge')
    expect(kinds.m1).toBe('tag')
    const head = map.stations.find(s => s.sha === 'f2')
    expect(map.train).toEqual({ x: (head?.x ?? 0) + 2, y: head?.y ?? -1, color: map.lanes[1]?.color })
    const at = (s: { x: number; y: number }) => map.ch[s.y * map.cols + s.x]
    expect(at(head ?? { x: 0, y: 0 })).toBe('●')
    expect(at(map.stations.find(s => s.sha === 'm3') ?? { x: 0, y: 0 })).toBe('◎')
  })

  test('a branch-off climbs at 45° and lines run between stations', () => {
    const map = layoutGraph(graphOf())
    expect(map.ch.includes('╱') || map.ch.includes('╲')).toBe(true)
    expect(map.ch.includes('━')).toBe(true)
    expect(map.ch.includes('╍')).toBe(true)
  })

  test('branches that own no commit of their own get no empty lane, and their names ride beside the station', () => {
    const g = graphOf()
    // Seven remote branches all pointing at m3, which main already owns.
    g.commits = g.commits.map(c => (c.sha === 'm3' ? { ...c, remotes: [...c.remotes, ...'abcdefg'.split('').map(x => `origin/${x}`)] } : c))
    // A new local branch created at main's tip.
    g.commits = g.commits.map(c => (c.sha === 'm3' ? { ...c, refs: [...c.refs, 'hotfix'] } : c))
    const map = layoutGraph(g)
    expect(map.lanes.some(l => l.name.startsWith('origin/a'))).toBe(false)
    expect(map.lanes.some(l => l.name === 'hotfix')).toBe(false)
    expect(map.labels.some(l => /hotfix/.test(l.text))).toBe(true)
  })

  test('a merge steeper than 45° drops straight instead of stacking slashes in one column', () => {
    // c1 sits three lanes below main and merges in one station later: too steep for 45°.
    const steep = [
      line('m2', 'm1 c1', 'HEAD -> refs/heads/main', 'Merge c', 1_700_000_500),
      line('c1', 'm1', '', 'C work', 1_700_000_400),
      line('a1', 'm1', 'refs/heads/a', 'A work', 1_700_000_300),
      line('b1', 'm1', 'refs/heads/b', 'B work', 1_700_000_200),
      line('m1', '', '', 'Base', 1_700_000_100),
    ].join('\n')
    const { commits, truncated } = parseLog(steep)
    const map = layoutGraph({ seq: 1, repo: 'd', root: '/p', commits, truncated, head: 'm2', branch: 'main', upstream: null, ahead: 0, behind: 0, cars: [] })
    const m2 = map.stations.find(s => s.sha === 'm2')
    const c1 = map.stations.find(s => s.sha === 'c1')
    expect(m2 !== undefined && c1 !== undefined).toBe(true)
    for (let x = (c1?.x ?? 0) + 1; x < (m2?.x ?? 0); x += 1) {
      let slashes = 0
      for (let y = (m2?.y ?? 0) + 1; y < (c1?.y ?? 0); y += 1) if (/[╱╲]/.test(map.ch[y * map.cols + x] ?? '')) slashes += 1
      expect(slashes).toBeLessThan(2)
    }
    expect(map.ch.includes('┃')).toBe(true)
  })

  test('rows come out as styled runs, overlays on top', () => {
    const map = layoutGraph(graphOf())
    const runs = rowRuns(map, 1, 0, map.cols, new Map([[0, { c: 'X', color: '#123456' }]]))
    expect(runs[0]?.text.startsWith('X')).toBe(true)
    expect(runs.map(r => r.text).join('').length).toBe(map.cols)
  })
})

type Answer = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const ok = (stdout: string): { value: Answer } => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (): { value: Answer } => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A fake git that answers what the hooks module asks, and counts history reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function host(on: any, counts: { log: number; show: number; status?: number }) {
  on('session.cwd', () => ({ value: '/p' }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    switch (args[0]) {
      case 'rev-parse':
        if (args.includes('--show-toplevel')) return ok('/p\n')
        if (args.includes('@{u}')) return ok('origin/feature\n')
        return ok('f2\n')
      case 'log':
        counts.log += 1
        return ok(LOG)
      case 'symbolic-ref':
        return ok('feature\n')
      case 'rev-list':
        return ok('1\t0\n')
      case 'status':
        counts.status = (counts.status ?? 0) + 1
        return ok(STATUS)
      case 'show':
        counts.show += 1
        return ok(`Ada${F}2026-10-01 10:00:00 +0000${F}Feature part one\n\nsrc/app.ts\nsrc/feature.ts\n`)
      default:
        return fail()
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const PANE = { component: 'Pane' as const, requestId: 'transit-map' }

test('an empty repository is an empty map, not "git log failed"', async ($, on) => {
  on('session.cwd', () => ({ value: '/p' }))
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    const args = e.argv.slice(1)
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok('/p\n')
    if (args[0] === 'status') return ok('?? README.md\0')
    // HEAD does not resolve yet; git log would fail.
    return fail()
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.run', () => ({ text: 'engine' }))
  const res = await $.command.run({ command: 'metro', args: '' } as never)
  expect(res.text).toMatch(/0 stations/)
  expect(res.text).not.toMatch(/failed/)
})

test('a read-only shell command does not walk the working tree', async ($, on) => {
  const counts = { log: 0, show: 0, status: 0 }
  host(on, counts)
  on('command.run', () => ({ text: 'engine' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' }, isReadOnly: true as const }))
  await $.command.run({ command: 'metro', args: '' } as never)
  const before = counts.status
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(counts.status).toBe(before)
})

test('/metro loads the map, opens the pane and draws the header and the Client', async ($, on) => {
  const counts = { log: 0, show: 0 }
  host(on, counts)
  on('command.run', () => ({ text: 'engine' }))
  const res = await $.command.run({ command: 'metro', args: '' } as never)
  expect(res.text).toMatch(/7 stations/)
  expect(counts.log).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'transit-map', surface, ...PANE, props: { title: 'Transit Map', bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 } } as never })
    expect(await ui.find({ type: 'Text', text: /TRANSIT MAP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feature → origin\/feature ↑1/ })).toBeDefined()
    expect(await ui.find({ key: 'metro' })).toBeDefined()
    await ui.unmount()
  }
})

test('surfaces without a Client get a timetable', async ($, on) => {
  host(on, { log: 0, show: 0 })
  on('command.run', () => ({ text: 'engine' }))
  await $.command.run({ command: 'metro', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'transit-map', surface: 'mobile', ...PANE, props: { title: 'Transit Map', bodyColumns: 60, scroll: { offset: 0, bodyRows: 20 } } as never })
  expect(await ui.find({ type: 'Text', text: /● f2 feature Feature part two/ })).toBeDefined()
  await ui.unmount()
})

test('git commands redraw the map; edits only move the train and light a car', async ($, on) => {
  const counts = { log: 0, show: 0 }
  host(on, counts)
  on('command.run', () => ({ text: 'engine' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  // Nothing happens before the map is opened.
  await $.tool.call({ tool: 'Bash', command: 'git commit -m wip' })
  expect(counts.log).toBe(0)
  await $.command.run({ command: 'metro', args: '' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m wip' })
  expect(counts.log).toBe(2)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(counts.log).toBe(2)
  await $.tool.call({ tool: 'Edit', file_path: '/p/notes.md', old_string: 'a', new_string: 'b' })
  expect(counts.log).toBe(2)
  const ui = await $.ui.mount({ plugin: 'transit-map', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} } as never })
  expect(await ui.find({ type: 'Text', text: /3 uncommitted, 1 edited by Claude/ })).toBeDefined()
  await ui.unmount()
})

test('the strip composes with other bands and can be switched off', async ($, on) => {
  host(on, { log: 0, show: 0 })
  on('command.run', () => ({ text: 'engine' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>OTHER MOD</Text>
  })
  const BAND = { component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as never }
  let ui = await $.ui.mount({ plugin: 'transit-map', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /▶▶▶/ })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'metro', args: '' } as never)
  ui = await $.ui.mount({ plugin: 'transit-map', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '▶▶▶' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
  await ui.unmount()
  const off = await $.command.run({ command: 'metro', args: 'strip off' } as never)
  expect(off.text).toMatch(/off/)
  ui = await $.ui.mount({ plugin: 'transit-map', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '▶▶▶' })).toBeUndefined()
  await ui.unmount()
})

test('selecting a station in the map shows its files', async ($, on) => {
  const counts = { log: 0, show: 0 }
  host(on, counts)
  on('command.run', () => ({ text: 'engine' }))
  await $.command.run({ command: 'metro', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'transit-map', surface: 'terminal', ...PANE, props: { title: 'Transit Map', bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 } } as never })
  await ui.key({ key: 'up', in: 'metro' })
  expect(counts.show).toBe(1)
  expect(await ui.find({ type: 'Text', text: /files: src\/app.ts, src\/feature.ts/, in: 'metro' })).toBeDefined()
  await ui.unmount()
})
