# The tools Cannu and its agents run: node, git, gh, Claude Code. Cannu's own
# code isn't copied in; compose mounts this folder at the same path it has on
# the host, so the hook path written into each worktree works in here and in
# an SSH terminal on the host alike. Add your repos' own tools (python, a
# compiler) to the apt line.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && corepack enable
