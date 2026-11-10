---
name: cannu
description: Start, check on, message and ship feature agents in Cannu, the dashboard that runs one Claude Code agent per feature on its own branch. Use when the user asks to start a feature, asks what the agents are doing, wants to tell a feature's agent something, or wants a feature merged or a PR opened.
---

# Cannu

Cannu runs on this machine at `http://127.0.0.1:4000` (change the port if
its `config.json` says otherwise) and serves several repos. `GET /api/repos`
lists them. Every other call goes under `/r/<repo>`, so `/api/status` below
means `http://127.0.0.1:4000/r/my-project/api/status` for the my-project repo. If the user
doesn't say which repo and there's more than one, ask. Every call is plain
HTTP with JSON, so use `curl -s`.

## Look

- `GET /api/status`: every feature, short. `status` is planned, building,
  merged or dropped. For a building one, `agent` says what its agent is
  doing: working, idle, closed (finished its turn, your move), needs-you,
  stuck, interrupted or error. `lastReply` is the start of the agent's last
  message, `pr` the pull request and its checks.
- `GET /api/features/<slug>/chat`: the whole conversation with one agent.

When the user asks what's going on, lead with what needs them: needs-you, stuck,
error, interrupted, then finished turns (closed) with a line from each
`lastReply`.

## Do

All `POST`, with a JSON body.

- `/api/features` `{"title": "...", "prompt": "..."}` starts a new feature
  and its agent. Add `"plan": true` to only record it. The prompt is what the
  agent starts on, so pass on the user's words, not a summary of them.
- `/api/features/<slug>/start` `{}` starts a planned feature.
- `/api/features/<slug>/feedback` `{"text": "..."}` messages the agent. If
  it's mid-turn, the message waits for the turn to end.
- `/api/features/<slug>/resume` `{"where": "background"}` carries on an
  interrupted agent.
- `/api/features/<slug>/pr` `{}` pushes the branch and opens (or updates)
  its pull request.

## Ask the user first

These can't be undone from here, so say what you're about to do and wait
for a yes in the same thread:

- `/api/features/<slug>/merge`: runs the repo's check and merges into main
  locally.
- `/api/features/<slug>/prmerge`: merges the pull request on GitHub.
- `/api/features/<slug>/drop`, `/api/features/<slug>/remove`.

Actions answer with `ok` and `msg` (creating a feature answers with the feature). Pass `msg` on as it is; on a failure, `out`
has the command's output.
