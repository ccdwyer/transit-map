# Transit Map

A Claude Code mod that draws your git history as a Vignelli-style subway map.

- **Lines are branches.** Each branch is a bold, flat-coloured line. Trunk (`main`, `master`) is always red.
- **Stations are commits.** Commits are `○` stations, merges are `◎` interchanges, and tags are `▣` termini with their name above.
- **Dashed lines are remote-only.** Branches that exist only on the remote are drawn dashed `╍`.
- **The train is your working tree.** It sits `▶▶▶` past HEAD on your current line, with one car `▮` per uncommitted file (up to 60). Cars light up yellow when Claude edits that file.
- **It's live.** When Claude commits, new stations pop in and the train slides forward. A branch switch slides the train onto another line.

`/metro` opens the map in a pane:

| Key | Action |
|---|---|
| `←` `→`, or drag | pan |
| `↑` `↓` | walk the stations |
| `PgUp` `PgDn` | scroll lines into view |
| click or `Enter` | show a commit's hash, author, subject and files |
| `f` | follow the train |

Hover over a station to see its subject.

After you open the map once, a one-row strip above the prompt shows the line you're on, your train and ahead/behind counts. `/metro strip off` hides it.

The map shows the newest 120 commits across all branches, plus HEAD's own history if you've checked out something older. A branch that shares another's tip (one you just created, or a merged remote) has no line of its own; its name rides beside the station. Past 10 lines, the rest share a grey `+N more lines` lane. The map refreshes after each turn, so commits a subagent made appear too. Surfaces without interactive regions, such as mobile, get a plain timetable instead.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install transit-map@ccdwyer-mods
/reload-plugins
```

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`
- `command.run{command=metro}`
- `tool.call`
- `turn.complete`
- `ui.message`
- `ui.render{component=Pane, requestId=transit-map}`
- `ui.render{component=AbovePrompt}`

Engine calls it makes: `$.command.register`, `$.process.run (via git)`, `$.session.cwd (via repoRoot)`, `$.state.get`, `$.state.set`, `$.ui.open`, `$.ui.resolve`.

A `tool.call` hook sits in the middle of every tool call: it can see the call, refuse it, or add context to its result. This mod only observes the result, to redraw the map after git commands and edits.

## Privacy

It runs entirely on your machine, using local `git` only. It sends nothing over the network. Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT
