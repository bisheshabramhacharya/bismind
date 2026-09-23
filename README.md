# BisMind

Talk to any coding-agent harness, and let it use **any other harness as its sub-agents**, each running in a terminal you can watch.

You pick a **sub-agent mode** once (for example *pi · deepseek-v4.1-flash* or *codex · gpt-5.6-sol*). From then on, whenever Claude Code, Codex or pi decides to use sub-agents inside BisMind, they are created in that mode instead of the harness's built-in ones. Each sub-agent is a real CLI agent in its own pane. Its final report goes back to the agent that spawned it.

```
┌ Workspaces ─┐┌──────────── Claude Code ─────────┬──── auth-api · pi ────┐┌ Dashboard ────────┐
│ BisMind  3  ││ > build the billing feature with  │ ● working 1m 12s      ││ Sub-agent mode    │
│  Claude     ││   3 sub-agents                    ├──── ui · pi ──────────┤│ Pi Codex Claude … │
│   ↳ auth-api││ ⏺ spawn_subagents (3)             │ ● done                ││ deepseek-v4.1-…   │
│   ↳ ui      ││ ⏺ wait_subagents …                ├──── tests · pi ───────┤│ Sub-agents        │
│   ↳ tests   ││ [3 sub-agents: auth-api ui tests] │ ● asking              ││  auth-api working │
└─────────────┘└───────────────────────────────────┴───────────────────────┘└───────────────────┘
```

## Run it

```bash
pnpm install
bismind            # starts the server if needed and opens the app window
```

(`bismind` is `~/.local/bin/bismind` → `bin/bismind.mjs`.) The server serves the built UI on
`http://127.0.0.1:4317`. For UI work, `pnpm dev` runs the server with `--watch` plus Vite on :5317
(`bismind --dev` opens that).

Requirements: Node 22.18+ (runs the TypeScript directly), tmux (`brew install tmux`), and whichever of
`claude`, `codex`, `pi` and `devin` you use.

## How it works

- **Every agent is a tmux session** on a private socket (`tmux -L bismind`). Agents keep running when
  the app window or the server goes away, and reattach when the server comes back. `bismind attach <name>`
  opens any agent in your own terminal.
- **Main agents** are the ones you talk to. BisMind launches them with its sub-agent tools and guidance
  on using sub-agents well: split the work, write self-contained briefs, spawn in parallel, wait instead
  of polling, answer questions, verify before reporting.
  - Claude Code: MCP tools via `--mcp-config`, guidance via `--append-system-prompt`, and a `PreToolUse`
    hook that **redirects** its built-in Agent/Task tool to BisMind (unless the mode is `native`).
  - Codex: MCP tools and `developer_instructions` via `-c` overrides.
  - pi: a pi extension (`pi-extension/bismind.ts`) that adds the tools. It also **pushes** each
    sub-agent's result back as a message, so pi never waits or polls.
- **Sub-agents** get a brief telling them how to report. Each harness signals the end of a turn with its final message:
  Claude Code → `Stop` hook · Codex → `notify` · pi → extension `agent_end` · Devin → `bismind done <<'EOF' …report… EOF`
  (Devin has no turn hook; if it never calls `done`, 45s of silence ends its turn with its screen as the report).
  A sub-agent that goes silent for 90s is marked stalled, and its screen is returned so the parent can decide what to do.
- **Questions (interactive sub-agents):** a sub-agent calls `ask_parent` (MCP or pi tool; Devin uses
  `bismind ask "…"`), then ends its turn. It shows under **Needs you** in the dashboard. The parent answers
  with `message_subagent`, or asks you first if the decision is yours. You can also answer straight from
  the dashboard. Sub-agents can post one-line `report_progress` notes.
- **Idle orchestrators cost nothing:** after spawning, the orchestrator ends its turn. Only a **question**
  wakes it (pi: pushed message; Claude Code/Codex: BisMind types `[BisMind] Sub-agent update…` into the idle
  pane). Finished work doesn't wake it: you see panes finish, then tell it what's next and `wait_subagents`
  returns every report at once (pi gets them queued for its next turn).
- **Tickets → PRs:** a task with `issue: <n>` gets its own worktree and branch, pushes it, and opens a PR
  whose body is its report plus `Closes #n`. The orchestrator prompt covers interview → spec → issues → PRs.
- **Agent references:** drag any agent (rail row, pane header, sub-agent chip) onto a terminal to paste
  `@bismind:<id> (name…; read it: bismind read <id>)`. It also drops as text into terminals outside the app.
  Any agent can follow it with `read_subagent` or `bismind read <id>` (task, status, last report, screen).
- **Sub-agents can't fan out:** inside a sub-agent the MCP server exposes only `ask_parent` and `report_progress`.
- **"Spawn N sub-agents" always lands:** the orchestrator prompt says to use exactly N, and for Claude a
  `UserPromptSubmit` hook adds a reminder whenever your message mentions sub-agents.
- **Parallel edits:** `isolate: true` gives a sub-agent its own git worktree and branch (`bismind/<name>-<id>`).

Nothing is written to your global harness configs. Everything is passed per launch. Look at
`~/.bismind/agents/<id>/launch.sh` to see exactly how an agent was started.

## Sub-agent tools (MCP server `bismind`, and the same names in pi)

| tool | what it does |
|---|---|
| `spawn_subagents` | start up to 12 sub-agents in parallel on the current mode; returns immediately |
| `wait_subagents` | block until all (or any) settle; returns each final report (pi gets them pushed) |
| `message_subagent` | answer a question, correct course, or give a follow-up |
| `read_subagent` | read any agent: task, status, last report and screen |
| `stop_subagent` · `list_subagents` · `subagent_mode` | |

Optional per task: `harness`, `model`, `thinking`, `cwd`, `isolate`, `issue`, `name`.

## CLI

```
bismind                         open the app window
bismind new <harness>           start claude|codex|pi|devin|shell here, attached to this terminal
bismind ls                      agents and their sub-agents
bismind attach <name>           attach this terminal to any agent (detach: ctrl-b d)
bismind mode [spec]             pi:<provider/model>[:thinking] | codex:<model> | claude:<model> | devin:<model> | native
bismind models <harness>        models you can use in a mode spec
bismind spawn --task "…"  ·  wait  ·  send <name> "…"  ·  read <name>  ·  kill <name>
bismind install claude|codex    register the MCP bridge globally (for sessions outside the app)
bismind up | stop | doctor
```

## Settings

`~/.bismind/settings.json` holds the mode, autonomy, workspaces and UI layout. **Autonomy**
`full` (default) launches sub-agents without permission prompts (`--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--permission-mode dangerous`); `ask` keeps each
harness's normal prompts, which you answer in the sub-agent's pane. Main agents always use their normal
permissions.

## Layout of the code

```
server/agents.ts       engine: spawn, tmux sessions, status, results, questions, waits, worktrees
server/harnesses.ts    how each harness is launched as a main agent or a sub-agent
server/prompts.ts      orchestrator + sub-agent guidance
server/orchestrate.ts  sub-agent batches, mode resolution, summaries
server/mcp.ts          stdio MCP bridge (answers the handshake instantly)
server/index.ts        REST + WebSocket + static UI
pi-extension/          pi integration
bin/bismind.mjs        CLI and hook entry point
src/                   the app (React + xterm.js): rail, canvas, panes, dashboard
```

The app is Code mode only: workspaces on the left, terminals in the middle, the Dashboard (sub-agent
mode, needs-you / working / idle) on the right. Click your name for Settings; the sun/moon switches the
light and dark themes.
