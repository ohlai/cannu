<img src="logo.png" alt="Cannu's logo, a silk moth" width="96">

# Cannu: agent board

Cannu runs Claude Code agents in parallel, one per task, on any git repo,
and shows them all on one board. Node built-ins only, nothing to install.

**What it does**

- Each task gets its own git branch, worktree, app port, data folder and
  Claude Code session, so agents never trip over each other.
- One board shows every task by status (planned, working, waiting, merged,
  dropped), what each agent is doing, and what it's cost in time and money.
- Chat with an agent from its card, or open the real session in a terminal.
- Preview each task's own copy of the app.
- Ship a task either way, from its card. **Check and merge** runs the
  repo's check against the branch and merges it locally. **Open PR** pushes
  it, opens a pull request and shows the CI result on the card.
- Every message I send is written word for word into the task's
  `prompts.md` by a hook, next to the agent's `log.md` and `decisions.md`.
- Notifications when an agent needs me, finishes, fails or gets stuck.
- Two rings at the top for the Claude plan's 5 hour and weekly limits (orange
  when close, red when full, grey when not known). Hover them for the numbers
  and reset times. While one is full Cannu starts no agents: new tasks are
  set up and wait, and a turn that hits the limit (in the background or in a
  terminal) is held. Held agents carry on by themselves once it resets. It
  reads Claude Code's login from `~/.claude/.credentials.json`; without that
  file the rings stay grey.
- Schedule a planned feature to start by itself: at a time, or some minutes
  before the 5-hour or weekly limit resets, so what's left of it isn't
  wasted (it starts 30 minutes before). Use the ▾ on **Start agent**, in New
  feature or on a planned card: Start now, Pick a time (a day and a time,
  filled in with today and the next hour), or before either limit resets.
  The card and its tile say when it starts. Cannu has to be running to start
  it: if the computer was off or asleep at that time, it doesn't start late by
  itself. The card says it was missed and when, with Start now. A limit's
  reset time comes from the usage reading, so with none the card says it's
  waiting on one, and with no 5-hour window running it starts straight away.
- A small HTTP API, so another agent (Hermes) can drive it. See `hermes/`.

**Why it's called Cannu.** It's named after Can Nü (蠶女), the silkworm girl of
Chinese myth and the goddess of silkworms and silk. Each agent is a silkworm
spinning its own thread in parallel, and Cannu weaves the threads into
something bigger.

## Running it

You need Node 24 or later, git, and Claude Code logged in. You also need `gh`
logged in if you want pull requests.

```
cp config.example.json config.json   # list your repos in it
node server.js                       # then open http://localhost:4000
```

You install Cannu once. One Cannu runs every repo listed in `config.json`, on
one port. The dropdown right of **+ New task** switches between them. Its
**+ Add repo** offers git repos found next to the ones you have, or takes any
folder, and starts that repo's board straight away without a restart. It's
saved in `config.json`. Picking a repo there also fills in how to work on it:
its own `cannu.json`, or Cannu's guess from its lockfile, `package.json` and
`mise.toml`. Saving writes `cannu.json` into the repo (only what isn't a
default) and commits it on its main branch. The bin next to a repo takes it
off the board. Nothing on disk is deleted, so adding it back picks up where it
left off.
Each repo's board has its own address (`http://localhost:4000/#my-project`), so
you can keep one tab per repo.

Behind the board, `server.js` runs a `repo.js` for each repo on its own
internal port. If one crashes, only that repo's board goes down, and it
restarts on its own. Its log is `local/<repo>.log`.

On Windows, `start-hidden.vbs` runs it with no window (output goes to
`local/dashboard.log`). Put a shortcut to it in `shell:startup` to start it
at login. Restart after changing `config.json` or any `.js` file.
`index.html` and `cannu.json` are read on every use.

### In Docker, on a server

`compose.yml` runs Cannu on a Linux server, using the host's Claude Code and
`gh` logins. Read the comment at the top of it first. Two rules matter:

- Mounts use the same paths inside and outside the container. Git worktrees
  record absolute paths, and Claude Code names each transcript folder after
  the working directory. A session opened from an SSH terminal on the host
  and one started in the container are only the same session if the paths
  match.
- Give Cannu its own clone of each repo, all under one folder
  (`CANNU_REPOS` in `compose.yml`). Agents commit to it and Cannu merges into
  its main, so it shouldn't be a folder a live container builds from.

Cannu has no login and can start agents that run commands, so it listens on
`127.0.0.1` only. To reach it from other machines, set `"host"` in
`config.json` to a list such as `["127.0.0.1", "100.64.0.1"]` (a Tailscale
address), or put a reverse proxy in front. Never use `0.0.0.0` on a network
you don't control.

## The two config files

**`config.json`** lives next to Cannu and is gitignored. It describes this
machine and lists the repos.

| Key | Default | What |
| --- | --- | --- |
| `repos` | | The repos, each `{ "repo": "../my-project" }`. Paths are relative to this file. A repo can also set `name` (its picker label and address, default the folder's name), `worktrees` (default `<repo>-worktrees`) and `firstFeaturePort` |
| `port` | `4000` | The board. Each repo's own Cannu takes the next ports up (4001, 4002, ...), on localhost only |
| `firstFeaturePort` | `8100` | Task apps get ports from here, in a block of 100 per repo, so repos never clash |
| `host` | `127.0.0.1` | Where the board listens. A string or a list |
| `claudeSettings` | | A settings file passed to Claude with `--settings`, such as one holding an API key, so Cannu never reads the key |
| `launchPrefix` | | Put before the Open session command, such as `ssh myserver ` |

**`cannu.json`** lives in the repo's root and is committed there. It says how
to work on this repo. Every key is optional; leave one out and Cannu uses the
default. `cannu.example.json` sets every key, so copy it and delete what you
don't need. It's plain JSON with no comments: the Agent defaults and Add repo
popups rewrite the file, so comments wouldn't survive anyway.

| Key | Default | What |
| --- | --- | --- |
| `main` | `main` | The branch tasks start from and merge into. Cannu also records each task (its `feature.md`) on it. Restart after changing |
| `notes` | `notes/features` | Where each task's notes go: `<notes>/<slug>/` holds `feature.md`, `prompts.md`, `log.md` and `decisions.md`. Restart after changing |
| `commitNotes` | `true` | `false` keeps task notes out of git entirely. They all live in the main folder, kept out of git through `.git/info/exclude`, so nothing is ever committed or pushed and a fresh clone has none. Agents are told not to `git add` them. Restart after changing |
| `copy` | `[]` | Files and folders git doesn't have (a local database, uploads, `.env`), copied from the main folder into each new worktree. Never overwrites. `.db` and `.sqlite` files are copied safely while open |
| `setup` | `[]` | Commands run once in a new worktree, in order, before the app starts, such as installing packages. Each gets 10 minutes; one failing stops setup. Retry setup runs them all again, so they should be safe to repeat |
| `app` | | The command that runs the app. It must listen on `PORT` within 20 seconds. Used by Preview, by agents restarting it after a change, and by Check and merge (a fresh copy on port + 1000). With no app, Preview is greyed out and says why. Cannu's own is `scripts/preview.js`, which runs the task's copy of Cannu on a demo repo, never your real ones |
| `seed` | `[]` | Commands run once the app is up (many apps make their tables when they start), such as loading demo data. Each gets 2 minutes. They run again on Retry setup, so they should skip what's already there |
| `check` | `package.json`'s `check` or `test` script | Has to pass before Check and merge merges, run with `APP_URL` pointing at a fresh copy of the branch's app. Agents are told to run it before they say they're done. `""` means no check |
| `merge` | `local` | Which ship button is the main (black) one on a card: `local` is Check and merge on this machine, `pr` is Open PR on GitHub with CI shown on the card. Both are always there |
| `agent` | | Agent defaults, below. The Agent defaults popup writes these, storing only what differs from Cannu's built-in values |

Every command runs in the task's folder through the shell, with these set:

| Variable | What |
| --- | --- |
| `PORT` | The task's own port |
| `DATA_DIR` | `<feature folder>/data`, for the app's database and files |
| `APP_URL` | `http://localhost:<PORT>` |
| `FEATURE_SLUG` | The task's short name, like `dark-mode` |

Keys inside `agent`:

| Key | Default | What |
| --- | --- | --- |
| `model` | Claude Code's own default | The model for new tasks (each can pick its own) |
| `systemPrompt` | | Added to every agent's system prompt, after Cannu's own short brief |
| `env` | | Extra environment variables for every agent |
| `allowedTools` | Reading, editing, and common git, node and npm commands | What a background turn may do without asking, as Claude Code permission rules. Anything else is refused and listed in red on the card |
| `disallowedTools` | `git push`, `checkout`, `switch` and `reset` | What a background turn may never do |
| `resumeText`, `freshText`, `conflictText` | Cannu's built-in wording | Messages Cannu sends for you: after an interrupted turn, when a session can't be reopened, and when merging conflicts. `{title}`, `{slug}`, `{notes}` and `{files}` are filled in |

## What every agent is told

Each agent reads the repo's own `CLAUDE.md`, and Cannu also gives it a short
system prompt. It says which task and branch the agent is on, to commit as
it goes and never push or switch branches, to keep `log.md` and
`decisions.md` in its notes folder, how to restart its app, and which check to
run. The repo doesn't need to say any of that.

## Where tasks are recorded

Each task is a folder on main, `<notes>/<slug>/`:

- `feature.md`: title, status, dates and what I asked for. Only the dashboard
  writes it, and every change is a commit on main ("Start task: X",
  "Merged: X", "Dropped: X").
- `prompts.md`: every message I sent the agent, word for word, written by a
  hook. Anything the dashboard added comes after a line saying
  `[Added by the dashboard, not my words]`.
- `log.md` and `decisions.md`: what the agent did and why, and every decision.

In `feature.md` a task is **planned** (no branch yet), **building**
(branch, folder and agent), **merged** (in main, and that's finished) or
**dropped** (kept on record, not doing it). On the page, building splits into
**waiting** (its agent has stopped and it's my turn) and **working**.

## Board and list

There are three views, picked with the switcher left of the search box:

- **By status**: a column per status (Waiting, Working, Planned, Merged,
  Dropped). Cards move on their own as agents change.
- **By label**: a column per label, plus Unlabelled. Drag a card to another
  column to relabel it, or drag a column's header to move the column (the
  order is saved in `labels.json`).
- **List**: cards in a list with a filter per status.

On the board, cards show the label (or the status, in the label view), what a
working agent is doing and the start of a waiting agent's last reply. The
**Show All / Hide Completed** toggle hides merged and dropped tasks. Both
it and the view are remembered per browser. The board reaches the bottom of the window, so its sideways
scrollbar is always at the bottom.

**Sort** (next to them) orders the cards in every column and the list at once:
needs you first (the default), last active, newest, name, or manual. In manual,
drag a card up or down to place it; that order is kept per browser.

Clicking a board card opens it in a popup with the cursor in the message box,
so a card moving underneath never moves what you're doing. The popup has the
card's details, its labels, the chat and the card's buttons.

**Labels**: one per task, any text. Click one in the popup to set it (click
it again to clear it), or click **+**, type a new one and press Enter. It's
saved as `- Label:` in `feature.md` and committed on main. A label's colour
comes from its name.

## What each button does

- **+ New task** (a popup): a name, what I want, and a model (the agent
  default unless I pick one, recorded in `feature.md`). What I've typed is
  kept for the browser tab if I close the popup. **Start agent** commits its
  `feature.md` on main, makes a worktree on branch `feat/<slug>`, copies in
  what `cannu.json` lists under `copy`, runs its `setup`, starts the `app`,
  runs its `seed`, and starts the agent on my prompt in the background.
  **Save as planned** only commits the `feature.md`.
- **Start agent / Edit / Drop** (planned tasks): start it as above, change
  its name or description (its popup has the same boxes as New task, and
  closing it saves), or mark it dropped. The model picker top right saves as
  soon as you pick.
- **Drop** (building tasks): for a bad idea. Its app stops and it's
  recorded as dropped. Its folder and branch stay until **Remove worktree**,
  which commits anything uncommitted to the branch first and keeps the branch,
  so the work and notes are still in git.
- **Chat**: the conversation so far, read from Claude Code's saved transcript,
  and a box to message the agent. A message goes as a background turn
  (`claude -p --resume`). If the agent is mid-turn, the message waits and goes
  as soon as the turn ends. If the session is open and idle in a terminal,
  sending closes that terminal session first, since one session can't run in
  two places. The conversation is kept, so Open session picks it back up.
  Anything a background turn wasn't allowed to do is listed in red. Paste or
  drag images and files into the chat: each is saved under the state folder's
  `attachments/<slug>/` (outside git) and its path goes into the message for
  the agent to read.
- **Open session**: the same session in a terminal, for watching it live or
  approving something. On Windows it opens a Windows Terminal tab. On Linux,
  macOS or Docker it gives you the command to run and copies it. Closing the
  terminal ends that run of the session, not the session.
- **Preview ↗ | ✕**: Preview starts the task's app if it isn't running and
  opens it. ✕ stops it. Agents restart it after changing code with
  `curl -s -X POST $CANNU_URL/api/features/$FEATURE_SLUG/apprestart`.
- **Check and merge**: commits the hook's `prompts.md` and refuses if the
  task or main has uncommitted changes. Then it starts the branch's own app
  on port + 1000, runs the `check` against it, and runs
  `git merge --no-ff` into main. On a conflict it aborts and fills in a
  message asking the agent to merge main in. It never pushes.
- **Open PR / Push / Merge PR**: Open PR pushes the branch and opens a pull
  request with `gh`. The card then shows the PR's CI checks, review and
  conflicts, refreshed every 30 seconds. **Push** sends new commits to the PR.
  **Merge PR** merges it on GitHub, pulls main down, records the task as
  merged and pushes that record. A PR merged directly on GitHub is picked up
  the same way.
- **After merging**, the task's agent and folder stay until you remove
  them, so you can keep chatting with it. While it works its card shows
  working, and once it has committed something main doesn't have, it goes back
  to waiting with Check and merge (or Open PR) to ship that too.
- **Remove worktree**: deletes the folder and branch once merged. The task
  stays in the list with its notes, read from main.
- **Carry on** (on an interrupted card): resumes the session with a message
  telling the agent it was cut off.
- **Retry setup**: re-runs setup. `copy` skips files already there, but
  every `setup` and `seed` command runs again, so they should be safe to
  repeat. Unfinished setups also re-run when the dashboard starts.
- **Reopen** (merged or dropped tasks): a new task that continues the
  old one, with the same boxes as New task (the model starts as the old
  one's). **Start agent** makes a new branch from current main and a new
  session pointed at the old notes. **Save as planned** records it to start
  later.
- **@ tagging**: typing @ in a description or a chat message lists matching
  tasks. Picking one writes `@slug`, which points the agent at that
  task's notes (recorded as Related in `feature.md`). Under the box, a line
  lists which @s link to a real task and which don't, and in shown text a
  linked @slug is underlined. Clicking a linked task closes the popup
  you're in (saving any edit) and opens that one. A card shows **Linked to**
  (the tasks it tags) and **Linked from** (the tasks that tag it), each
  only when there are any.
- **Agent defaults** (a popup): everything the dashboard sends an agent. That
  covers the default model, the repo's own system prompt, extra environment variables,
  the carry on, new session and merge conflict messages, and what background
  turns may and may never do. Only what differs from the built-in values is
  saved, under `agent` in `cannu.json`, and committed on main.
- **Bells**: notifications when an agent needs me, finishes, fails or is
  interrupted, only while the page is open. The options are silent, only
  tasks with their bell on, or all.
- Every card ends with one row of buttons: everyday ones on the left, and on
  the right in black the one that moves the task on. Drop, Check and merge,
  Open PR, Merge PR and Remove worktree ask "are you sure?" first. Once one of
  them has done its job in a card's popup, the popup closes.

## Waiting and working

A building task is **working** while its agent is mid-turn or being set
up, and **waiting** otherwise. The pill adds why when it matters:

- **needs you**: it's asking for permission in its terminal.
- **terminal open**: it finished its turn, and its terminal session is open.
- **interrupted**: it was mid-turn when its process died. Use Carry on.
- **error**: the last background run failed. Its output is on the card.
- **never started**: the agent never got going.
- **stuck**: it's mid-turn, but nothing has happened for 3 minutes: no hook
  report and nothing written to its transcript. The card says what's still
  running under the agent, with **End that step** to kill just that so the
  agent carries on. For a background turn there's also **Stop the turn**.

Liveness comes from the claude process IDs that `launch.js` and background
runs record. They're checked with `tasklist` on Windows and `/proc` elsewhere.

## How it knows what agents are doing

Each worktree gets a `.claude/settings.local.json`, kept out of git through
the repo's `.git/info/exclude`. It holds the worktree's `PORT`, `DATA_DIR`,
`APP_URL`, `CANNU_URL`, git identity, and hooks that run this folder's
`hook.js`. It's rewritten whenever the dashboard starts. It also turns off the
GitKraken hooks plugin for agents (it held a permission request open for 20
minutes) and the Claude co-author line on their commits. The hook writes
`local/state/<slug>.json` and appends every message to the task's
`prompts.md`. Time and cost per task come from the transcripts Claude Code
saves under `~/.claude/projects/`, priced at API rates.

## Driving it from another agent

`GET /api/repos` lists the repos. For each one, `GET /r/<repo>/api/status`
returns a short list of every task and what its agent is doing, and the
actions are plain `POST`s under `/r/<repo>/api/`. `hermes/SKILL.md` is a skill that
teaches Hermes, or any agent that reads skills, to start tasks, check on
them, message them and ship them. It asks first before anything that merges
or deletes. Copy it into the agent's skills folder.

## Speed

Every open page polls every 2 seconds. A task's git state is only re-read
when its agent reports something, after an action, or every 15 seconds, and
then for every task at once without blocking the server. Open pages share
one result, and a transcript is only re-read when it changes. Before this, a refresh with
8 worktrees on Windows took about 6 seconds, because each task's git reads
ran one after another and blocked everything else, chat included.
