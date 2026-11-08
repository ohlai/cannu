// Runs inside a Windows Terminal tab the dashboard opened. Starts (or
// resumes) the feature's claude session in its worktree and records the
// claude process ID, so the dashboard can tell whether it's still running.
// Usage: node launch.js <slug> new|resume|continue
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadFeatures, saveRuntime, readState, writeState, claudeBaseArgs, resumeText, defaults, fill, AUTO } from "./lib.js";

const [slug, mode] = process.argv.slice(2);
const f = loadFeatures().find((x) => x.slug === slug);
if (!f) { console.error(`No feature called ${slug}`); process.exit(1); }

// Variables that tie a process to whichever Claude Code session started the
// dashboard. An agent that inherits them isn't its own session.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(k)));

// Claude Code keeps each session's transcript under ~/.claude/projects, in a
// folder named after the working directory. No transcript means --resume
// has nothing to open.
const transcript = (id) => path.join(os.homedir(), ".claude", "projects", f.dir.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);

const st = readState(slug);
const id = st.session_id || f.sessionId;
const args = [...claudeBaseArgs(f), "-n", f.slug];
if (mode === "new" || !st.started) {
  args.push("--session-id", f.sessionId, f.launchPrompt || f.prompt);
} else if (fs.existsSync(transcript(id))) {
  args.push("--resume", id);
  if (mode === "continue") args.push(resumeText());
} else {
  // The old conversation can't be opened, so start a fresh session in the
  // same worktree that picks up from the notes.
  const fresh = crypto.randomUUID();
  saveRuntime(slug, { lostSessions: [...(f.lostSessions || []), id], sessionId: fresh });
  console.log(`The previous session (${id}) has no saved conversation, so this is a new session that picks up from the notes.\n`);
  args.push("--session-id", fresh, `${AUTO} ${fill(defaults().freshText, { title: f.title, slug: f.slug })}`);
}

const child = spawn("claude", args, { cwd: f.dir, stdio: "inherit", env });
writeState(slug, { pid: child.pid });
child.on("exit", (c) => {
  // Only clear the PID if it's still ours, so closing one tab can't make
  // another running session look closed.
  if (readState(slug).pid === child.pid) writeState(slug, { pid: null });
  process.exit(c ?? 0);
});
