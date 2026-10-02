// One commit as the map needs it. `refs` are local branch names, `remotes`
// remote-tracking names (origin/main), `tags` tag names.
export type Commit = {
  sha: string
  parents: string[]
  author: string
  time: number
  subject: string
  refs: string[]
  remotes: string[]
  tags: string[]
}

// One uncommitted path: its porcelain status code and whether Claude edited it
// this session (its train car lights up).
export type Car = { path: string; code: string; lit: boolean }

export type Graph = {
  // Bumped on every refresh, so the map knows when to lay out again.
  seq: number
  repo: string
  // The repository's top-level folder, so a refresh in another checkout redraws the whole map.
  root: string
  // Newest first, topological order, capped.
  commits: Commit[]
  truncated: boolean
  head: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  cars: Car[]
}

export type Detail = { sha: string; author: string; date: string; subject: string; files: string[] }

declare module 'claude-code' {
  interface PluginState {
    'transit-map': {
      graph: Graph | null
      detail: Detail | null
      strip: boolean
      lit: string[]
      error: string | null
    }
  }
}
