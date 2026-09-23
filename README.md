# BisMind — rough draft, not v1

**What this is:** a canvas of real terminal panes, each running a real CLI agent, plus a bridge so one
agent can open others as visible sub-agents. **What it is not:** finished. Expect rough edges.

Known rough edges (honest list):
- Restarting the pane server kills every live pane (folders, layout and pane metadata survive).
- Workspaces/panes are not reattached after a server restart; you reopen them by hand.
- No tmux backing yet, so you cannot attach to a pane from your own terminal.
- Agent mode and Thread mode do not exist (the buttons are disabled on purpose).
- The right sidebar holds a pane dashboard; there is no browser preview pane.
- If a CLI has no provider/auth configured (pi today), its pane opens and prints the CLI's own
  error — that is the CLI, not the canvas.

If the canvas says "pane server offline", the terminals are fine — the server process is not
running. Start it with `pnpm dev` in this folder, then hit Retry.

A pane canvas of **real** CLI agent terminals, plus a bridge so one agent can spawn others —
headed (visible TUI) or headless — inside those panes.

Modelled on BridgeMind's Code mode: a let rail of workspace folders, a canvas of stacked or
split panes, and a picker that opens Claude Code, Codex, Cursor Agent, Devin, Grok Build, Pi,
Command Code, opencode, Cline or a plain shell.

```
┌ workspaces ─┐┌──────────── pane canvas ────────────┐┌ dashboard ─┐
│ BisMind  2  ││ Cursor Agent   ~/Projects/app       ││ needs you  │
│  Cursor     ││  (live terminal)                    ││ working    │
│  Codex      ││ Codex          ~/Projects/app       ││ idle       │
│             ││  (live terminal)                    ││            │
└─────────────┘└─────────────────────────────────────┘└────────────┘
```

## Run it

```bash
pnpm install        # chmods node-pty's spawn-helper as a postinstall
pnpm dev            # pane server on :4317 + UI on http://localhost:5317
```

Open the URL the pane server prints (it carries the token):

```
open "http://localhost:5317/?t=$(cat ~/.bismind/token)"
```

`pnpm build && node bin/bismind.mjs up` serves the built UI from the pane server instead
(`http://127.0.0.1:4317`).

## CLI

```
bismind up                  start the pane server, print the canvas URL
bismind mcp                 MCP bridge on stdio (what agent CLIs launch)
bismind install <target>    print the MCP registration for a CLI (--write applies it)
                            codex | grok | devin | claude | cursor | gemini | opencode
                            claude-agents → Claude Code subagent files that delegate to pi/devin/codex
bismind clis                which agent CLIs are installed
bismind doctor              readiness per CLI, with auth notes
bismind status | stop
```

## The point: agents spawning agents

Every pane is a real PTY running a real CLI. The MCP bridge exposes that canvas to any agent
that speaks MCP, so a parent agent can delegate:

| MCP tool | What it does |
|---|---|
| `list_clis` | which agent CLIs are installed |
| `spawn_agent` | open a pane running another CLI as a sub-agent (`headed: true` = visible TUI) |
| `ask_agent` | spawn + wait + return the output (headed by default, `headed: false` for quiet runs) |
| `list_panes` | every pane, its CLI, cwd, status and parent |
| `read_pane` | recent output as plain text (ANSI stripped) |
| `wait_for_agent` | block until `exit`, `idle`, or a `pattern` |
| `send_to_pane` | answer an interactive prompt in a sub-agent TUI |
| `close_pane` | kill the sub-agent |
| `run_command` | run a shell command in a visible pane and return its output |

Sub-agents pass `parent_pane_id`, so the canvas draws the lineage (`↳ from Codex`) and the rail
nests the child under its parent. That nesting is the recursive part: a pane spawned by an
agent can itself spawn panes.

### Wiring a parent agent

```bash
bismind install claude --write          # writes mcpServers.bismind into ~/.claude.json
bismind install claude-agents --write   # ~/.claude/agents/{pi,devin,codex,delegate}.md
bismind install codex  --write          # codex mcp add bismind -- node …/bismind.mjs mcp
bismind install grok   --write
bismind install cursor --write          # merges ~/.cursor/mcp.json
```

`~/.claude/agents/pi.md` is a Claude Code subagent whose whole job is: call
`mcp__bismind__spawn_agent` with `cli: "pi"`, `headed: true`, the full task, then
`wait_for_agent` + `read_pane` and report back. So "Claude Code, use pi for this" works, and
you watch pi work in a pane.

Add any other CLI to the registry without touching code — `~/.bismind/clis.json`:

```json
[{ "id": "myagent", "label": "My Agent", "bins": ["myagent"],
   "args": ["--tui"], "exec": ["--headless", "{prompt}"],
   "modelArgs": ["--model", "{model}"], "accent": "#9ca3af" }]
```

## REST API (what the UI and MCP both drive)

```
GET    /api/clis                    installed CLIs + provider lists
GET    /api/panes                   every pane
POST   /api/panes                   {cli, cwd, prompt?, headed?, model?, provider?, args?, parent_pane_id?}
GET    /api/panes/:id?lines=200     pane + plain-text tail
POST   /api/panes/:id/input         {text, submit}
POST   /api/panes/:id/wait          {until: exit|idle|pattern, pattern?, timeout_ms?}
DELETE /api/panes/:id
GET    /api/workspaces              POST to add a folder, DELETE /api/workspaces/:id
PATCH  /api/state                   {layout, sidebarHidden, paneWorkspace}
WS     /ws?t=<token>                attach | detach | input | resize ⇄ snapshot | data | status | created | closed
```

Auth: a random token in `~/.bismind/token`, required as `x-bismind-token` or `?t=`. The server
binds 127.0.0.1 only.

## Keyboard

`⌘T` new pane · `⌘B` rail · `⇧⌘B` dashboard · click a pane to focus it · `esc` closes the picker.

## Notes

- **Lightweight by design:** one PTY per pane with a capped buffer; the server coalesces
  output; the browser batches terminal writes for background panes at 4 fps and only the
  focused pane is interactive. Six panes per workspace.
- **Headed vs headless:** a prompt plus a CLI that has a headless mode (`claude -p`,
  `codex exec`, `devin -p`, `pi -p`, `cursor-agent -p`, `grok -p`, `opencode run`) runs
  headless unless you pass `headed: true`; CLIs without one get the prompt typed into their TUI.
- **Models:** `model`/`provider` map to each CLI's own flags (`pi --provider … --model …`,
  `codex --model …`). Pi lists its providers in the picker; it needs `pi` → `/login` once.
- **State** lives in `~/.bismind/state.json` (folders, layout, pane→workspace); live PTYs live
  in the server process, so reloading the UI reattaches.
- Panes and processes are real: closing a pane kills its CLI.
