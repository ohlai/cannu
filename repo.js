// One repo's Cannu: its features, agents, previews and shipping, as an HTTP
// API on its own internal port. server.js starts one of these per repo and
// serves the board in front of them. Node built-ins only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CLAUDE_SETTINGS, META, APP, WORKTREES, STATE, FEATURES_DIR, REPO_FILE, MAIN, NOTES, COMMIT_NOTES, notesDir, repo, repoRaw, BUILT_IN, MODELS, defaults, fill, MD_KEYS, config, loadFeatures, saveRuntime, featureMd, readState, writeState, stamp, claudeBaseArgs, liveStatus, killTree, AUTO, resumeText, FEEDBACK, forget, watchUsage, fullLimit, refreshUsage } from "./lib.js";
watchUsage();

const WIN = process.platform === "win32";

// If the dashboard was started from inside a Claude Code session, it carries
// variables that would make every agent it launches a child of that session
// (and such agents don't get their own saved conversation). Drop them, so
// nothing started from here inherits them.
for (const k of Object.keys(process.env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(k)) delete process.env[k];

// ---------- helpers ----------

function git(cwd, ...args) {
  return execFileSync("git", ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function tryGit(cwd, ...args) {
  try { return { ok: true, out: git(cwd, ...args) }; } catch (e) { return { ok: false, out: String(e.stdout || "") + String(e.stderr || e.message) }; }
}
// Read-only git that doesn't block the server. The overview runs these for
// every feature at once instead of one after another: on Windows each git
// start costs about 100ms, and the board used to wait 5s or more on them.
const gitAsync = (cwd, ...args) => new Promise((resolve) => execFile("git", args, { cwd, encoding: "utf8", windowsHide: true }, (e, out) => resolve(e ? "" : out.trim())));
// Commits use the repo's own identity if set, else the author of the last
// commit, so the dashboard never changes git config.
const author = (() => {
  const get = (k) => { try { return execFileSync("git", ["config", k], { cwd: APP, encoding: "utf8" }).trim(); } catch { return ""; } };
  const [n, e] = execFileSync("git", ["log", "-1", "--format=%an|%ae"], { cwd: APP, encoding: "utf8" }).trim().split("|");
  return { name: get("user.name") || n, email: get("user.email") || e };
})();

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    // Detached on Linux and macOS, so it leads its own process group and
    // killTree ends whatever it started too.
    const p = spawn(cmd, args, { detached: !WIN, ...opts, windowsHide: true });
    opts.onSpawn?.(p.pid);
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    if (opts.input != null) { p.stdin.end(opts.input); }
    const t = opts.timeout ? setTimeout(() => killTree(p.pid), opts.timeout) : null;
    p.on("close", (code) => { if (t) clearTimeout(t); resolve({ code, out }); });
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
  });
}
// A command from cannu.json, through the shell, in a feature's folder.
const sh = (cwd, cmd, extra = {}) => run(cmd, [], { cwd, shell: true, ...extra });
// What the repo's commands get: their own port and data folder.
const appEnv = (f, port = f.port) => ({ ...process.env, FEATURE_SLUG: f.slug, PORT: String(port), DATA_DIR: path.join(f.dir, "data"), APP_URL: `http://localhost:${port}` });

function portUp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(300, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "feature";
const tail = (s, n = 3000) => (s.length > n ? "…" + s.slice(-n) : s);
const day = (iso) => (iso ? iso.slice(0, 10) : "");

// Commits just these paths on main, whatever else is staged or changed there.
function commitMain(message, ...paths) {
  if (git(APP, "branch", "--show-current") !== MAIN) throw new Error(`The repo folder isn't on ${MAIN}, so Cannu can't record this. Switch it back to ${MAIN}.`);
  git(APP, "add", "--", ...paths);
  if (tryGit(APP, "diff", "--cached", "--quiet", "--", ...paths).ok) return; // nothing changed
  git(APP, "commit", "-q", "-m", message, "--", ...paths);
}

// Fields that belong in feature.md are written there and committed on main
// (pass `message` for that). Everything else is this machine's runtime.
function update(slug, patch, message) {
  const md = Object.fromEntries(Object.entries(patch).filter(([k]) => MD_KEYS.has(k)));
  const rt = Object.fromEntries(Object.entries(patch).filter(([k]) => !MD_KEYS.has(k)));
  if (Object.keys(rt).length) saveRuntime(slug, rt);
  if (Object.keys(md).length) {
    const f = { ...loadFeatures().find((x) => x.slug === slug), ...md };
    writeFeature(f, message || `${f.title}: ${Object.keys(md).join(", ")}`);
  }
  return loadFeatures().find((x) => x.slug === slug);
}
function writeFeature(f, message) {
  const dir = path.join(FEATURES_DIR, f.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "feature.md"), featureMd(f));
  if (COMMIT_NOTES) commitMain(message, path.join(NOTES, f.slug, "feature.md"));
}
const registered = (dir) => tryGit(APP, "worktree", "list", "--porcelain").out.toLowerCase().replace(/\\/g, "/").includes(dir.toLowerCase().replace(/\\/g, "/"));
const branchExists = (b) => tryGit(APP, "rev-parse", "--verify", "-q", `refs/heads/${b}`).ok;

// The command that opens a feature's session in a terminal. launch.js starts
// claude with the right args and records its PID.
const launchCmd = (f, mode) => `${config.launchPrefix || ""}${WIN ? "" : `CANNU_REPO=${config.name} `}node "${path.join(META, "launch.js")}" ${f.slug} ${mode}`;
// On Windows, a new Windows Terminal tab running it. Anywhere else (a
// server, Docker) Cannu can't open a window on your screen, so it hands back
// the command to run. Returns the message for the card.
function openTab(f, mode) {
  if (WIN && !config.noTabs) {
    spawn("wt.exe", ["-w", "0", "nt", "--title", f.slug, "-d", f.dir, "node", path.join(META, "launch.js"), f.slug, mode], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, msg: "Opened a new terminal tab." };
  }
  return { ok: true, msg: `Run this in a terminal:\n${launchCmd(f, mode)}`, cmd: launchCmd(f, mode) };
}

// ---------- pointing an agent at other features' notes ----------

// Where an agent can read a feature's notes. If it was merged before `since`
// (when the asking feature branched), the notes are already in the asking
// branch. Otherwise point at wherever they live now.
function notesRef(t, since) {
  if (!COMMIT_NOTES || (t.status === "building" && t.dir)) return notesDir(t) + path.sep;
  if (t.merged && since && t.merged >= since) return path.join(APP, NOTES, t.slug) + path.sep;
  return `${NOTES}/${t.slug}/`; // on main before this branch started, so in it too
}
function describe(t, since) {
  const status = t.status === "building" ? `not merged yet, on ${t.branch}` : t.merged ? `merged ${day(t.merged)}` : t.status;
  return `- "${t.title}" (${status}): read ${notesRef(t, since)} (prompts.md, log.md, decisions.md)`;
}
// Text added after the user's own words, clearly marked, so prompts.md keeps
// exactly what they wrote. Only the starting prompt passes a title.
function contextBlock({ title, continues, refs }, since) {
  const all = loadFeatures();
  const lines = title ? [`Feature: ${title}`] : [];
  const c = continues && all.find((x) => x.slug === continues);
  if (c) lines.push(`This continues an earlier feature. Read its notes before starting, and log what this round changes compared with it:`, describe(c, since));
  const r = (refs || []).map((s) => all.find((x) => x.slug === s)).filter((x) => x && x.slug !== continues);
  if (r.length) lines.push(`For context, read the notes of these related features:`, ...r.map((t) => describe(t, since)));
  return lines.length ? `\n\n---\n${AUTO}\n${lines.join("\n")}` : "";
}

// ---------- add, plan, start ----------

// A new feature is a feature.md committed on main. Planned ones stop there.
// Started ones get a branch made from main after that commit, so the branch
// has its feature.md, and only main ever changes it.
function createFeature(title, prompt, { continues = null, refs = [], plan = false, model = "", label = "" } = {}) {
  const list = loadFeatures();
  if (list.some((f) => f.title.toLowerCase() === title.toLowerCase())) throw new Error("A task already has that name. Pick another.");
  const base = slugify(title);
  let slug = base;
  for (let n = 2; list.some((f) => f.slug === slug) || fs.existsSync(path.join(FEATURES_DIR, slug)) || fs.existsSync(path.join(WORKTREES, slug)) || branchExists(`feat/${slug}`); n++) slug = `${base}-${n}`;
  const f = { slug, title, prompt, status: "planned", label, created: stamp(), continues, refs, model: model in MODELS ? model : "" };
  if (plan) { writeFeature(f, `Plan task: ${title}`); return f; }
  return startFeature(f, `Start task: ${title}`);
}

// Gives a feature its port, folder, branch and session, records it as
// building on main, and sets it up. For a new feature or a planned one.
function startFeature(f, message) {
  if (!f.prompt?.trim()) throw new Error("It needs a prompt saying what you want before an agent can start on it.");
  const list = loadFeatures();
  const port = Math.max(config.firstFeaturePort - 1, ...list.map((x) => x.port || 0)) + 1;
  const started = stamp();
  Object.assign(f, { status: "building", started, branch: `feat/${f.slug}` });
  saveRuntime(f.slug, { port, dir: path.join(WORKTREES, f.slug), sessionId: crypto.randomUUID(), setup: "starting", launchPrompt: f.prompt + contextBlock(f, started), removed: null });
  writeFeature(f, message);
  const full = loadFeatures().find((x) => x.slug === f.slug);
  startSetup(full);
  return full;
}

// Every step checks whether it's already done, so setup can be re-run after
// a crash or restart and picks up where it stopped.
const settingUp = new Set();
function startSetup(f) {
  if (settingUp.has(f.slug)) return;
  settingUp.add(f.slug);
  setup(f).catch((e) => update(f.slug, { setup: "failed: " + e.message })).finally(() => settingUp.delete(f.slug));
}

// The worktree's gitignored Claude Code settings: its port and data folder,
// git identity, and hooks that report to this dashboard. Rewritten whenever
// the dashboard starts, so they always point at this copy of hook.js.
// Adds a line to the repo's .git/info/exclude: ignored like .gitignore, but
// never committed, and shared by all its worktrees.
function exclude(line) {
  try {
    const ex = path.resolve(APP, git(APP, "rev-parse", "--git-common-dir"), "info", "exclude");
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
    if (!cur.split(/\r?\n/).includes(line)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, `\n# Cannu\n${line}\n`); }
  } catch {}
}
if (!COMMIT_NOTES) exclude(`/${NOTES}/`);

function writeSettings(f) {
  fs.mkdirSync(path.join(f.dir, ".claude"), { recursive: true });
  exclude(".claude/settings.local.json");
  const hook = () => ({ hooks: [{ type: "command", command: `node "${path.join(META, "hook.js")}"`, timeout: 10 }] });
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "StopFailure", "SessionEnd"];
  fs.writeFileSync(path.join(f.dir, ".claude", "settings.local.json"), JSON.stringify({
    env: {
      ...defaults().env, // the user's extra variables; the ones below win, the dashboard relies on them
      FEATURE_SLUG: f.slug, PORT: String(f.port), DATA_DIR: path.join(f.dir, "data"), APP_URL: `http://localhost:${f.port}`, CANNU_URL: `http://127.0.0.1:${config.port}`,
      // So hook.js and launch.js, run by the agent, know which repo they belong to.
      CANNU_REPO: config.name, ...(process.env.CANNU_CONFIG ? { CANNU_CONFIG: process.env.CANNU_CONFIG } : {}),
      // This machine has no git identity, so agents commit as the repo's author.
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    },
    hooks: Object.fromEntries(events.map((e) => [e, [hook()]])),
    // GitKraken's plugin holds every permission request open for up to a day
    // waiting for an answer in GitKraken. A background turn can't answer, so
    // it froze an agent for 20 minutes. Agents run without it.
    enabledPlugins: { "gitkraken-hooks@gitkraken": false },
    // No "Co-Authored-By: Claude" line on agents' commits.
    includeCoAuthoredBy: false,
    attribution: { commit: "", pr: "" },
  }, null, 2));
}

async function setup(f) {
  const step = (s) => update(f.slug, { setup: s });
  step("making worktree");
  fs.mkdirSync(WORKTREES, { recursive: true });
  if (!registered(f.dir)) {
    tryGit(APP, "worktree", "prune");
    if (fs.existsSync(f.dir)) fs.rmSync(f.dir, { recursive: true, force: true }); // half-made folder from a crash
    if (branchExists(f.branch)) git(APP, "worktree", "add", "-q", f.dir, f.branch);
    else git(APP, "worktree", "add", "-q", f.dir, "-b", f.branch, MAIN);
  }

  writeSettings(f);
  const r = repo();

  // cannu.json "copy": files and folders from the main checkout that git
  // doesn't have (a local database, uploads, a .env). Never overwrites, so a
  // retry keeps what the feature already changed. SQLite files are copied
  // with VACUUM INTO, which is safe while the main app has them open.
  step("copying files");
  for (const rel of r.copy) {
    const src = path.join(APP, rel), dst = path.join(f.dir, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: false });
    else if (/\.(db|sqlite3?)$/.test(rel)) {
      const tmp = dst + ".partial";
      fs.rmSync(tmp, { force: true });
      const db = new DatabaseSync(src, { readOnly: true });
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      db.close();
      fs.renameSync(tmp, dst);
    } else fs.copyFileSync(src, dst);
  }

  // cannu.json "setup": install packages and the like, in order.
  for (const cmd of r.setup) {
    step("running " + cmd);
    const out = await sh(f.dir, cmd, { env: appEnv(f), timeout: 600000 });
    if (out.code !== 0) throw new Error(`${cmd} failed: ` + tail(out.out, 400));
  }

  // cannu.json "seed": runs once the app is up, since an app often makes its
  // own tables at start. Seeds should skip what's already there, so a retry
  // is fine.
  if (r.app) {
    step("starting the app");
    const a = await startApp(f);
    if (!a.ok) throw new Error(a.msg);
  }
  for (const cmd of r.seed) {
    step("running " + cmd);
    const out = await sh(f.dir, cmd, { env: appEnv(f), timeout: 120000 });
    if (out.code !== 0) throw new Error(`${cmd} failed: ` + tail(out.out, 400));
  }

  step("ready");
  // Start the agent in the background. Open session shows it in a terminal.
  if (!readState(f.slug).started) {
    writeState(f.slug, { state: "starting", session_id: f.sessionId });
    headless(f, f.launchPrompt || f.prompt, "starting on your prompt", true);
  }
}

// ---------- talking to the agent ----------

// @slug in what the user writes tags a related feature: the agent reads its notes.
function mentions(text, self) {
  const all = loadFeatures();
  return [...new Set([...String(text || "").matchAll(/@([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]))].filter((s) => s !== self && all.some((x) => x.slug === s));
}
function withMentions(f, text) {
  return text + contextBlock({ refs: mentions(text, f.slug) }, f.started || f.created);
}

// One turn in the background (`claude -p`). `first` starts the session
// instead of resuming it.
// Background runs this dashboard has going, by slug. Checked before the
// process list, which is cached and can miss a run that only just started.
const running = new Set();
// While a Claude usage limit is full, a turn isn't started: it's held, and
// carried on by itself once the limit resets (see heldTick). A turn that runs
// into the limit part way is held the same way, to carry on from where it
// stopped.
function hold(f, held, resets) {
  writeState(f.slug, { state: "limited", activity: "", headlessPid: null, held, limitResets: resets || null, limitTried: Date.now() });
}
function headless(f, text, label, first = false) {
  const full = fullLimit();
  if (full) return hold(f, { text, label, first }, full.resets);
  running.add(f.slug);
  const st = readState(f.slug);
  writeState(f.slug, { state: "working", activity: label, denied: [], held: null });
  const session = first ? ["--session-id", f.sessionId] : ["--resume", st.session_id || f.sessionId];
  const d = defaults();
  const args = ["-p", ...session, "-n", f.slug, ...claudeBaseArgs(f),
    "--permission-mode", "acceptEdits",
    ...(d.allowedTools.length ? ["--allowedTools", ...d.allowedTools] : []),
    ...(d.disallowedTools.length ? ["--disallowedTools", ...d.disallowedTools] : []),
    "--output-format", "json"];
  run("claude", args, {
    cwd: f.dir, input: text, env: { ...process.env, META_HEADLESS: "1", META_VIA: "dashboard" },
    onSpawn: (pid) => writeState(f.slug, { headlessPid: pid }),
  }).then(({ code, out }) => {
    let reply = tail(out), denied = [];
    let failed = code !== 0;
    try { const j = JSON.parse(out.slice(out.indexOf("{"))); reply = j.result ?? reply; failed ||= !!j.is_error; denied = (j.permission_denials || []).map((d) => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 120)}`); } catch {}
    running.delete(f.slug);
    if (failed && LIMIT_HIT.test(String(reply).slice(0, 400))) {
      // If the session never got saved, start it again; otherwise carry it on.
      const saved = fs.existsSync(path.join(transcriptDir(f), `${f.sessionId}.jsonl`));
      hold(f, first && !saved ? { text, label, first } : { text: resumeText(), label: "carrying on after the usage limit" }, fullLimit()?.resets);
      writeState(f.slug, { lastReply: reply });
      // The usage we had may not show the limit as full yet: fetch it, for the reset time.
      refreshUsage().then(() => { if (fullLimit()) writeState(f.slug, { limitResets: fullLimit().resets }); });
      return;
    }
    writeState(f.slug, { state: code === 0 ? "idle" : "error", activity: "", headlessPid: null, lastReply: reply, denied });
    pump(f.slug); // send the next waiting message straight away
  });
}

// Every message from the dashboard is queued, then sent as a background turn
// as soon as the agent is free. One session can't run in two places, so if
// it's open and idle in a terminal, that terminal session is closed first.
// The conversation is saved, so nothing is lost and Open picks it back up.
function feedback(f, raw) {
  fs.mkdirSync(FEEDBACK, { recursive: true });
  fs.appendFileSync(path.join(FEEDBACK, f.slug + ".md"), `\n## ${stamp()}\n\n${raw}\n`);
  writeState(f.slug, { queue: [...(readState(f.slug).queue || []), withMentions(f, raw)] });
  const r = pump(f.slug);
  return { sent: r === "sent", why: r };
}
function pump(slug) {
  const st = readState(slug);
  if (!st.queue?.length) return "empty";
  const f = loadFeatures().find((x) => x.slug === slug);
  if (!f || !hasWorktree(f) || settingUp.has(slug) || !st.started) return "not-started";
  const live = liveStatus(st);
  if (running.has(slug)) return "busy";
  if (live.background || live.state === "working" || live.state === "needs-you" || st.state === "starting") return live.open ? "busy-terminal" : "busy";
  if (fullLimit() || st.state === "limited") return "limited"; // kept queued, and sent once the limit resets and the held turn has run
  if (live.open && st.pid) {
    killTree(st.pid);
    writeState(slug, { pid: null });
  }
  const [next, ...rest] = st.queue;
  // Out of the queue but not in the transcript until Claude starts up: chat()
  // shows it as sending in that gap, so it doesn't vanish for a second or two.
  writeState(slug, { queue: rest, sending: { text: next, at: new Date().toISOString() } });
  headless(f, next, "your message from the dashboard");
  return "sent";
}
// A held turn carries on by itself once its limit resets. It waits for the
// reset time it was held with, even if the usage we have says it's free (that
// can be stale). Without a known reset time it tries every 10 minutes; a try
// that's too early just hits the limit and is held again.
function heldTick(f, st) {
  if (st.state !== "limited" || !st.held || !hasWorktree(f)) return;
  const full = fullLimit();
  if (full) { if (st.limitResets !== full.resets) writeState(f.slug, { limitResets: full.resets }); return; }
  if (!defaults().autoContinue) return;
  if (st.limitResets ? Date.parse(st.limitResets) > Date.now() : Date.now() - (st.limitTried || 0) < 10 * 60e3) return;
  continueHeld(f);
}
setInterval(() => {
  for (const f of loadFeatures()) {
    const st = readState(f.slug);
    heldTick(f, st);
    if (st.queue?.length) pump(f.slug);
  }
}, 3000);

// The conversation so far, from Claude Code's saved transcript: what was
// sent, and the agent's last words in each turn.
// Claude Code keeps each session's transcript in a folder named after the
// working directory.
const transcriptDir = (f) => path.join(os.homedir(), ".claude", "projects", f.dir.replace(/[^A-Za-z0-9]/g, "-"));
// Parsed transcripts, kept until the file changes. A transcript can be over
// 10MB, so parsing it on every poll was most of the wait for a card's chat.
const chatCache = new Map();
function chat(f) {
  const st = readState(f.slug);
  const id = st.session_id || f.sessionId;
  const file = path.join(transcriptDir(f), `${id}.jsonl`);
  let key = "";
  try { const t = fs.statSync(file); key = `${t.mtimeMs}:${t.size}`; } catch {}
  let c = chatCache.get(file);
  if (!c || c.key !== key) { c = { key, ...readChat(file) }; chatCache.set(file, c); }
  const s = st.sending;
  const landed = s && c.messages.some((m) => m.who !== "agent" && Date.parse(m.at) >= Date.parse(s.at));
  const sending = s && !landed ? [{ who: s.text.startsWith(AUTO) ? "dashboard" : "me", text: s.text, sending: true }] : [];
  const queued = (st.queue || []).map((q) => ({ who: "me", text: q, queued: true }));
  return { messages: [...c.messages, ...sending, ...queued].slice(-80), saved: c.saved };
}
function readChat(file) {
  const out = []; let reply = null;
  const flush = () => { if (reply) out.push(reply); reply = null; };
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch {}
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (e.type === "user" && !e.isMeta) {
      if (Array.isArray(c) && c.some((x) => x.type === "tool_result")) continue;
      const text = (typeof c === "string" ? c : (c || []).filter((x) => x.type === "text").map((x) => x.text).join("\n")).trim();
      if (!text || text.startsWith("<")) continue; // slash-command plumbing and system notes
      flush();
      out.push({ who: text.startsWith(AUTO) ? "dashboard" : "me", text, at: e.timestamp });
    } else if (e.type === "assistant" && Array.isArray(c)) {
      const text = c.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
      if (text) reply = { who: "agent", text, at: e.timestamp };
    }
  }
  flush();
  return { messages: out.slice(-80), saved: lines.length > 1 };
}

// Runs the turn a usage limit held back.
function continueHeld(f) {
  const st = readState(f.slug);
  if (st.state !== "limited" || !st.held) return { ok: false, msg: "Nothing is waiting on the usage limit." };
  const full = fullLimit();
  if (full) return { ok: false, msg: `Your ${full.which === "session" ? "5-hour" : "weekly"} Claude limit is still full.` };
  // Hit in a terminal: that session is still open, and one session can't run in two places.
  if (st.pid && liveStatus(st).open) { killTree(st.pid); writeState(f.slug, { pid: null }); }
  headless(f, st.held.text, st.held.label, st.held.first);
  return { ok: true, msg: "Carrying on in the background." };
}

function resume(f, where) {
  const live = liveStatus(readState(f.slug));
  if (live.open || live.background || running.has(f.slug)) return { ok: false, msg: "The agent is still running." };
  if (where === "terminal") return openTab(f, readState(f.slug).started ? "continue" : "new");
  if (!readState(f.slug).started) {
    headless(f, f.launchPrompt || f.prompt, "starting on your prompt", true);
    return { ok: true, msg: "Starting it in the background." };
  }
  headless(f, resumeText(), "carrying on after an interruption");
  return { ok: true, msg: "Carrying on in the background." };
}

// ---------- each feature's app ----------

// On Windows, whatever is listening on the port, whoever started it (the
// dashboard, the agent, or me by hand). Only used when Cannu didn't start it.
function listenerPid(port) {
  if (!WIN) return null;
  // netstat on Windows leaves out some listeners, and PowerShell shows
  // their State as blank, so take whichever process owns a socket on that
  // local port (only the server has one).
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Where-Object OwningProcess -gt 0 | Select-Object -First 1).OwningProcess`], { encoding: "utf8", windowsHide: true });
    return Number(out.trim()) || null;
  } catch { return null; }
}
const appLog = (f) => path.join(STATE, f.slug + "-app.log");

// cannu.json "app", detached, so it keeps running if the dashboard restarts.
async function startApp(f) {
  const cmd = repo().app;
  if (!cmd) return { ok: false, msg: "This repo has no app to run (no \"app\" in cannu.json)." };
  if (await portUp(f.port)) return { ok: true, msg: "Already running." };
  const log = fs.openSync(appLog(f), "a");
  fs.writeSync(log, `\n--- ${stamp()} started from the dashboard: ${cmd} ---\n`);
  const p = spawn(cmd, [], { cwd: f.dir, shell: true, env: appEnv(f), detached: true, windowsHide: true, stdio: ["ignore", log, log] });
  p.unref();
  fs.closeSync(log);
  writeState(f.slug, { appPid: p.pid });
  for (let i = 0; i < 100; i++) { if (await portUp(f.port)) return { ok: true, msg: "Started." }; await new Promise((r) => setTimeout(r, 200)); }
  return { ok: false, msg: `The app didn't start listening on port ${f.port} within 20 seconds. End of its log:\n` + tail(fs.readFileSync(appLog(f), "utf8"), 800) };
}
async function stopApp(f) {
  const pid = readState(f.slug).appPid;
  if (pid) { killTree(pid); writeState(f.slug, { appPid: null }); }
  if (!(await portUp(f.port))) return { ok: true, msg: pid ? "Stopped." : "It wasn't running." };
  const other = listenerPid(f.port);
  if (other) { killTree(other); return { ok: true, msg: "Stopped." }; }
  return { ok: false, msg: `Something Cannu didn't start is still listening on port ${f.port}. Stop it where it was started.` };
}

// ---------- time and cost, from Claude Code's saved conversations ----------

// API prices per million tokens (from the claude-api skill, 2026-10-06).
// Cache writes are 1.25x input (5 minute) or 2x (1 hour).
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
function price(model, u) {
  const p = PRICES[Object.keys(PRICES).find((k) => String(model).startsWith(k))];
  if (!p) return 0;
  const cw = u.cache_creation;
  const w5 = cw ? cw.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  const w1 = cw ? cw.ephemeral_1h_input_tokens || 0 : 0;
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output + w5 * p.input * 1.25 + w1 * p.input * 2 + (u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
}
// Agent time is the time inside turns: from each prompt to the agent's last
// step before the next one, so time spent waiting on me doesn't count. Gaps
// over 10 minutes (a permission prompt left waiting) count as 10.
function readTranscript(file) {
  const msgs = new Map(); let ms = 0, prev = 0, last = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const t = Date.parse(e.timestamp) || 0;
    const c = e.message?.content;
    const prompt = e.type === "user" && !e.isMeta && !(Array.isArray(c) && c.some((x) => x.type === "tool_result"));
    if (t && prev && !prompt) ms += Math.min(t - prev, 10 * 60e3);
    if (t) prev = t;
    // A reply is saved as several lines with the same id. The last has the totals.
    if (e.type === "assistant" && e.message?.id && e.message.usage) msgs.set(e.message.id, e.message);
    if (e.type === "assistant" && e.message?.model?.startsWith("claude")) last = { model: e.message.model, at: t };
  }
  let cost = 0; for (const m of msgs.values()) cost += price(m.model, m.usage);
  return { ms, cost, last };
}
const usageCache = new Map();
function usage(f) {
  const dir = transcriptDir(f);
  let files = []; try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch {}
  const total = { ms: 0, cost: 0 };
  for (const n of files) {
    const p = path.join(dir, n);
    let r;
    try {
      const mtime = fs.statSync(p).mtimeMs, c = usageCache.get(p);
      if (c?.mtime === mtime) r = c.r; else { r = readTranscript(p); usageCache.set(p, { mtime, r }); }
    } catch { continue; }
    total.ms += r.ms; total.cost += r.cost;
    if (r.last && !(total.last?.at >= r.last.at)) total.last = r.last;
  }
  return total;
}

// What "Claude Code's default" actually is. Claude Code doesn't say, but each
// saved session records the model it ran on, so it's the newest model used by
// an agent started without --model (no model on the feature or in the agent
// defaults). Remembered in local/, so it still shows once a default is picked.
const CLAUDE_DEFAULT = path.join(STATE, "..", "claude-default.json");
function settingsModel() {
  // The --settings file wins over the user's own settings, as it does for Claude Code.
  for (const p of [CLAUDE_SETTINGS, path.join(os.homedir(), ".claude", "settings.json")]) {
    if (!p) continue;
    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8")).model;
      if (typeof m === "string" && m) {
        const id = m.replace(/\[.*\]$/, "").toLowerCase();
        return Object.keys(MODELS).find((k) => k && (id === k || k.includes("-" + id + "-"))) || id;
      }
    } catch {}
  }
  return "";
}
function claudeDefault() {
  if (defaults().model) return "";
  const set = settingsModel();
  if (set) return set;
  let known = null; try { known = JSON.parse(fs.readFileSync(CLAUDE_DEFAULT, "utf8")); } catch {}
  for (const f of loadFeatures()) {
    if (f.model || !f.dir) continue;
    const l = usage(f).last;
    if (l && !(known?.at >= l.at)) known = l;
  }
  if (known) fs.writeFileSync(CLAUDE_DEFAULT, JSON.stringify(known));
  return known?.model || "";
}

// ---------- merge, done, remove ----------

// Commits the hook's prompts.md (it's written after the agent's last
// commit), then says why the branch can't go anywhere yet, or "".
function readyToShip(f) {
  const pf = `${NOTES}/${f.slug}/prompts.md`;
  if (tryGit(f.dir, "status", "--porcelain", "--", pf).out) { git(f.dir, "add", pf); git(f.dir, "commit", "-q", "-m", `${f.title}: record prompts`); }
  if (tryGit(f.dir, "status", "--porcelain").out) return "The task has uncommitted changes. Ask the agent to commit first.";
  if (git(APP, "rev-list", "--count", `${MAIN}..${f.branch}`) === "0") return `Nothing to ship: the branch has no commits ${MAIN} doesn't have.`;
  return "";
}

// cannu.json "check", against a fresh copy of the app started from the
// branch's committed code on a spare port, so a stale server can't make it
// pass. No check configured passes.
async function runCheck(f) {
  const r = repo();
  if (!r.check) return { code: 0, out: "" };
  const port = f.port + 1000;
  const srv = r.app ? spawn(r.app, [], { cwd: f.dir, shell: true, env: appEnv(f, port), detached: !WIN, windowsHide: true, stdio: "ignore" }) : null;
  try {
    if (srv) for (let i = 0; i < 100 && !(await portUp(port)); i++) await new Promise((res) => setTimeout(res, 200));
    return await sh(f.dir, r.check, { timeout: 600000, env: appEnv(f, port) });
  } finally { if (srv) killTree(srv.pid); }
}

async function merge(f) {
  const why = readyToShip(f);
  if (why) return { ok: false, step: "feature", msg: why };
  if (tryGit(APP, "status", "--porcelain").out) return { ok: false, step: "main", msg: `${MAIN} has uncommitted changes in the repo folder. Commit or stash them first.` };
  if (git(APP, "branch", "--show-current") !== MAIN) return { ok: false, step: "main", msg: `The repo folder isn't on ${MAIN}.` };

  const check = await runCheck(f);
  if (check.code !== 0) return { ok: false, step: "check", msg: `The check (${repo().check}) failed on the task's branch.`, out: tail(check.out) };

  const m = tryGit(APP, "merge", "--no-ff", "-q", f.branch, "-m", `Merge ${f.branch}: ${f.title}`);
  if (!m.ok) {
    const files = tryGit(APP, "diff", "--name-only", "--diff-filter=U").out;
    tryGit(APP, "merge", "--abort");
    const list = files.split("\n").filter(Boolean);
    return { ok: false, step: "conflict", msg: `Merging conflicts with ${MAIN}. Nothing was changed on ${MAIN}.`, files: list, draft: fill(defaults().conflictText, { files: list.join(", ") }) };
  }
  update(f.slug, { status: "merged", merged: stamp() }, `Merged: ${f.title}`);
  await stopApp(f); // merged: its preview is done with
  return { ok: true, msg: `Merged into ${MAIN} and stopped its preview. Not pushed.` };
}

// ---------- pull requests ----------
//
// The other way to ship: Cannu pushes the branch and opens a pull request
// with the GitHub CLI, the repo's CI runs the checks, and the card shows
// their result. Merge PR merges it on GitHub and pulls main back down. The
// agent never pushes; only these do.

const gh = (...args) => run("gh", args, { cwd: APP, timeout: 60000 });

async function openPR(f) {
  const why = readyToShip(f);
  if (why) return { ok: false, msg: why };
  const push = await run("git", ["push", "-u", "origin", f.branch], { cwd: APP, timeout: 120000 });
  if (push.code !== 0) return { ok: false, msg: "git push failed.", out: tail(push.out) };
  if (f.pr) { prPoll(f, true); return { ok: true, msg: `Pushed. Pull request #${f.pr} is updated.` }; }
  const body = `${f.prompt || ""}\n\n---\nOpened by Cannu. The agent's notes are in \`${NOTES}/${f.slug}/\`.`;
  const c = await gh("pr", "create", "--head", f.branch, "--base", MAIN, "--title", f.title, "--body", body);
  // Already open (made by hand, or by an earlier Cannu): adopt it.
  const url = (c.out.match(/https:\/\/\S+\/pull\/\d+/) || [])[0];
  if (!url) return { ok: false, msg: "gh pr create failed. Is gh logged in (gh auth status) and does the repo have a GitHub remote?", out: tail(c.out) };
  update(f.slug, { pr: Number(url.split("/").pop()), prUrl: url });
  prPoll(loadFeatures().find((x) => x.slug === f.slug), true);
  return { ok: true, msg: `Opened pull request #${url.split("/").pop()}.` };
}

// What GitHub says about each open PR, refreshed in the background so a
// slow or offline GitHub never holds up the board.
const prInfo = new Map();
async function prPoll(f, force = false) {
  const old = prInfo.get(f.slug);
  if (!f.pr || old?.busy || (!force && old && Date.now() - old.at < 30e3)) return;
  prInfo.set(f.slug, { ...old, busy: true });
  const r = await gh("pr", "view", String(f.pr), "--json", "state,url,mergeable,reviewDecision,statusCheckRollup");
  let info = { at: Date.now(), error: "couldn't reach GitHub" };
  try {
    const j = JSON.parse(r.out);
    const runs = j.statusCheckRollup || [];
    const res = runs.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
    const checks = !runs.length ? "none"
      : res.some((x) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(x)) ? "failing"
      : res.every((x) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(x)) ? "passing" : "running";
    info = { at: Date.now(), state: j.state, url: j.url, mergeable: j.mergeable, review: j.reviewDecision || "", checks, failed: runs.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT"].includes((c.conclusion || c.state || "").toUpperCase())).map((c) => c.name || c.context) };
  } catch {}
  prInfo.set(f.slug, info);
  // Merged on GitHub (from here or not): record it. A feature only has a pr
  // while that PR is open, so this also catches a merged feature's second PR.
  if (info.state === "MERGED") await afterPRMerged(f).catch(() => {});
}
setInterval(() => { for (const f of loadFeatures()) if (f.pr) prPoll(f); }, 10e3);

async function mergePR(f) {
  const m = await gh("pr", "merge", String(f.pr), "--merge");
  if (m.code !== 0) { prPoll(f, true); return { ok: false, msg: "GitHub refused the merge.", out: tail(m.out) }; }
  return afterPRMerged(f);
}
// main gets the merge from GitHub, then the feature is recorded as merged,
// and that record is pushed so main on GitHub has it too.
async function afterPRMerged(f) {
  if (git(APP, "branch", "--show-current") !== MAIN || tryGit(APP, "status", "--porcelain").out) {
    return { ok: false, msg: `Merged on GitHub, but the repo folder isn't a clean ${MAIN}, so Cannu didn't pull it. Clean it up and the card catches up within a minute.` };
  }
  const pull = await run("git", ["pull", "--no-rebase", "--no-edit", "origin", MAIN], { cwd: APP, timeout: 120000 });
  if (pull.code !== 0) return { ok: false, msg: `Merged on GitHub, but pulling ${MAIN} failed.`, out: tail(pull.out) };
  // pr cleared: new commits after this get a new pull request, not this one.
  update(f.slug, { status: "merged", merged: stamp(), pr: null, prUrl: null }, `Merged: ${f.title} (#${f.pr})`);
  await stopApp(f);
  const push = await run("git", ["push", "origin", MAIN], { cwd: APP, timeout: 120000 });
  prInfo.delete(f.slug);
  return { ok: true, msg: `Merged #${f.pr} and pulled it into ${MAIN}.` + (push.code !== 0 ? ` Pushing the "Merged" record to ${MAIN} failed, so push it yourself.` : "") };
}

// A bad idea, planned or part built. A built one's app stops, but its folder
// and branch stay (Remove worktree deletes the folder; an unmerged branch is
// kept), so the work isn't lost.
async function dropFeature(f) {
  if (!["planned", "building"].includes(f.status)) return { ok: false, msg: "Only planned or building tasks can be dropped." };
  if (f.dir && !f.removed) {
    const live = liveStatus(readState(f.slug));
    if (live.open || live.background || running.has(f.slug) || settingUp.has(f.slug)) return { ok: false, msg: "The agent is still running. Let it finish or close its session first." };
    await stopApp(f);
  }
  update(f.slug, { status: "dropped", dropped: stamp() }, `Dropped: ${f.title}`);
  return { ok: true, msg: "Dropped. It stays on record under Dropped." };
}

// Deletes the folder and branch but keeps the feature in the list. A merged
// feature's notes are on main from then on.
async function removeFeature(f) {
  if (!f.merged && f.status !== "dropped") return { ok: false, msg: "Not merged yet. Merge it first, or drop it." };
  const live = liveStatus(readState(f.slug));
  if (live.open || live.background) return { ok: false, msg: "The agent is still running. Close its session first." };
  if (registered(f.dir)) {
    // A dropped feature's half-done work is committed to its branch, which is
    // kept, so deleting the folder loses nothing.
    if (f.status === "dropped" && tryGit(f.dir, "status", "--porcelain").out) { git(f.dir, "add", "-A"); git(f.dir, "commit", "-q", "-m", `${f.title}: dropped, work in progress kept`); }
    if (tryGit(f.dir, "status", "--porcelain").out) return { ok: false, msg: "The task has uncommitted changes. Not removing." };
    await stopApp(f); // a running app holds files in the folder
    // Windows chokes on pnpm's linked node_modules inside git's delete, so clear it first.
    fs.rmSync(path.join(f.dir, "node_modules"), { recursive: true, force: true });
    tryGit(APP, "worktree", "remove", "--force", f.dir);
    tryGit(APP, "worktree", "prune");
    if (registered(f.dir)) return { ok: false, msg: "git couldn't remove the worktree. Close any terminal or server using it and try again." };
  }
  let leftover = "";
  try { fs.rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { leftover = ` The folder ${f.dir} is still open in something (a terminal or editor?), so delete it by hand.`; }
  // -d refuses an unmerged branch, so a dropped feature's work stays in git.
  const b = tryGit(APP, "branch", "-d", f.branch);
  update(f.slug, { removed: stamp() });
  return { ok: true, msg: (b.ok ? "Removed the worktree and branch. The task and its notes stay in the list." : `Removed the worktree. The branch ${f.branch} is kept because it isn't merged, so its work and notes are still in git.`) + leftover };
}

// ---------- labels ----------

// Every label, in labels.json in the notes folder, as name → { description,
// color }, so a label can have no features in it. It goes in git only when
// feature notes do (commitNotes). A label only on features (from before this
// file) counts too, and is saved the next time anything is. No color: the
// board picks one from the name.
const LABELS_REL = path.join(NOTES, "labels.json");
const LABELS_FILE = path.join(APP, LABELS_REL);
const cleanLabel = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 40);
const labelInfo = (description, color) => ({ description: String(description || "").trim(), ...(/^#[0-9a-f]{6}$/i.test(color) ? { color: color.toLowerCase() } : {}) });
function readLabels() {
  let l = {}; try { l = JSON.parse(fs.readFileSync(LABELS_FILE, "utf8")); } catch {}
  for (const k in l) if (typeof l[k] === "string") l[k] = labelInfo(l[k]); // the first version stored just the description
  for (const f of loadFeatures()) if (f.label && !(f.label in l)) l[f.label] = labelInfo();
  return l;
}
// labels.json plus any changed feature.md (and any deleted feature folders),
// in one commit on main when notes are in git.
function saveLabels(l, feats, message, gone = []) {
  fs.mkdirSync(FEATURES_DIR, { recursive: true });
  fs.writeFileSync(LABELS_FILE, JSON.stringify(l, null, 2) + "\n");
  for (const f of feats) fs.writeFileSync(path.join(FEATURES_DIR, f.slug, "feature.md"), featureMd(f));
  if (COMMIT_NOTES) commitMain(message, LABELS_REL, ...feats.map((f) => path.join(NOTES, f.slug, "feature.md")), ...gone.map((s) => path.join(NOTES, s)));
}
function setLabel(f, label) {
  const l = readLabels(); // still has its old label, so that column stays when it empties
  if (label) l[label] ??= labelInfo();
  saveLabels(l, [{ ...f, label }], label ? `Label ${f.title}: ${label}` : `Unlabel ${f.title}`);
}
function newLabel(name, description = "", color = "") {
  const l = readLabels();
  if (!name) throw new Error("Needs a name.");
  if (name in l) throw new Error("There's already a label called that.");
  l[name] = labelInfo(description, color);
  saveLabels(l, [], `New label: ${name}`);
}
// Rename, describe, recolour. Its features move to the new name.
function editLabel(name, to, description, color) {
  const l = readLabels();
  if (!(name in l)) throw new Error("That label doesn't exist any more.");
  if (!to) throw new Error("Needs a name.");
  if (to !== name && to in l) throw new Error("There's already a label called that.");
  // rebuilt so a renamed label keeps its place in the order
  const out = Object.fromEntries(Object.entries(l).map(([k, v]) => k === name ? [to, labelInfo(description, color)] : [k, v]));
  saveLabels(out, loadFeatures().filter((f) => f.label === name).map((f) => ({ ...f, label: to })), to === name ? `Edit label ${name}` : `Rename label ${name} to ${to}`);
}
// Columns go in labels.json's key order. Names left out keep their place at the end.
function orderLabels(names) {
  const l = readLabels(), out = {};
  for (const n of [...(Array.isArray(names) ? names.map(cleanLabel) : []), ...Object.keys(l)]) if (n in l) out[n] = l[n];
  saveLabels(out, [], "Reorder labels");
}
// A copy of the label, with a planned copy of each feature in it (same prompt
// and model). Copies are planned, so no branches or agents start.
function duplicateLabel(name) {
  const l = readLabels();
  if (!(name in l)) throw new Error("That label doesn't exist any more.");
  const named = (end) => name.slice(0, 40 - end.length) + end; // its number survives the 40 character limit
  let to = named(" copy");
  for (let n = 2; to in l; n++) to = named(` copy ${n}`);
  newLabel(to, l[name].description, l[name].color);
  const feats = loadFeatures().filter((f) => f.label === name);
  for (const f of feats) {
    let title = `${f.title} (copy)`;
    for (let n = 2; loadFeatures().some((x) => x.title.toLowerCase() === title.toLowerCase()); n++) title = `${f.title} (copy ${n})`;
    createFeature(title, f.prompt || "", { refs: f.refs, plan: true, model: f.model || "", label: to });
  }
  return { ok: true, msg: `Made ${to} with ${feats.length} planned ${feats.length === 1 ? "copy" : "copies"}.` };
}
// Deletes the label and every feature in it: building ones are dropped, any
// worktree is removed (an unmerged branch is kept, as Remove worktree does),
// then their notes folders go, in one commit on main when notes are in git.
async function deleteLabel(name) {
  const l = readLabels();
  if (!(name in l)) throw new Error("That label doesn't exist any more.");
  const feats = loadFeatures().filter((f) => f.label === name);
  const busy = feats.find((f) => { const live = liveStatus(readState(f.slug)); return running.has(f.slug) || settingUp.has(f.slug) || (f.dir && !f.removed && (live.open || live.background)); });
  if (busy) return { ok: false, msg: `${busy.title}'s agent is still running. Let it finish or close its session first. Nothing was deleted.` };
  for (const f of feats) {
    if (f.status === "building") { const r = await dropFeature(f); if (!r.ok) return { ok: false, msg: `${f.title}: ${r.msg}` }; }
    const now = loadFeatures().find((x) => x.slug === f.slug);
    if (now.dir && !now.removed) { const r = await removeFeature(now); if (!r.ok) return { ok: false, msg: `${f.title}: ${r.msg} The label wasn't deleted.` }; }
  }
  for (const f of feats) { fs.rmSync(path.join(FEATURES_DIR, f.slug), { recursive: true, force: true }); forget(f.slug); }
  delete l[name];
  saveLabels(l, [], `Delete label ${name} and its ${feats.length} features`, feats.map((f) => f.slug));
  return { ok: true, msg: `Deleted ${name} and ${feats.length} ${feats.length === 1 ? "task" : "tasks"}.` };
}

// ---------- overview ----------

const hasWorktree = (f) => !!f.dir && !f.removed && f.status !== "planned" && f.status !== "dropped";

// A feature's git state only changes when its agent does something, when
// main moves, or when a button here does something. So it's re-read when the
// agent's last report changes, after any action, or every 15s at most,
// instead of on every 2s poll.
const gitCache = new Map();
let gitEpoch = 0; // bumped by any action
function gitInfo(f, st) {
  const key = `${st.at}|${gitEpoch}`;
  const c = gitCache.get(f.slug);
  if (c && c.key === key && Date.now() - c.t < 15e3) return c.p;
  const p = Promise.all([
    gitAsync(APP, "rev-list", "--left-right", "--count", `${MAIN}...${f.branch}`),
    gitAsync(f.dir, "status", "--porcelain"),
    gitAsync(f.dir, "log", "-1", "--format=%s (%cr)"),
  ]);
  gitCache.set(f.slug, { key, t: Date.now(), p });
  return p;
}

async function buildOverview() {
  return Promise.all(loadFeatures().map(async (f) => {
    const st = readState(f.slug);
    // No worktree: planned, imported, dropped, or removed after merging.
    if (!hasWorktree(f)) return { ...f, st, worktree: false, live: { state: f.status }, usage: f.dir ? usage(f) : null };
    const exists = fs.existsSync(f.dir);
    const [[counts, status, lastCommit], appUp] = exists ? await Promise.all([gitInfo(f, st), portUp(f.port)]) : [["", "", ""], false];
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    const dirty = status.split("\n").filter(Boolean).length;
    let live = liveStatus(st, running.has(f.slug));
    const stuckInfo = stuck(f, st, live);
    if (stuckInfo) live = { ...live, state: "stuck" };
    if (f.pr) prPoll(f);
    return { ...f, st, live, stuck: stuckInfo, settingUp: settingUp.has(f.slug), ahead: ahead || 0, behind: behind || 0, dirty, lastCommit, worktree: true, appUp, usage: usage(f), prInfo: prInfo.get(f.slug) || null };
  }));
}
// Every open page polls every 2s. They share one build at a time, and a
// build is reused for a second.
let ovCache = { at: 0, p: null };
function overview() {
  if (!ovCache.p || Date.now() - ovCache.at > 1000) {
    const p = buildOverview().finally(() => { if (ovCache.p === p) ovCache.at = Date.now(); });
    ovCache = { at: Infinity, p };
  }
  return ovCache.p;
}
const fresh = () => { ovCache = { at: 0, p: null }; gitEpoch++; };

// A turn that's gone quiet: working, but no hook report and nothing written
// to its transcript for 3 minutes. Usually something it's waiting on has hung,
// like a hook that never returns. Says what's still running under the agent.
const QUIET = 3 * 60e3;
function stuck(f, st, live) {
  if (live.state !== "working") return null;
  const t = path.join(transcriptDir(f), `${st.session_id || f.sessionId}.jsonl`);
  let last = Date.parse(st.at) || 0;
  try { last = Math.max(last, fs.statSync(t).mtimeMs); } catch {}
  if (Date.now() - last < QUIET) return null;
  return { since: new Date(last).toISOString(), on: st.activity || "", waitingOn: childOf(st.headlessPid || st.pid) };
}
// The oldest process the agent started that's still running (a hook or a
// command), or null. Cached for 15s since PowerShell is slow.
const childCache = new Map();
function childOf(pid) {
  if (!pid) return null;
  const c = childCache.get(pid);
  if (c && Date.now() - c.at < 15e3) return c.r;
  let r = null;
  if (!WIN) {
    // The oldest child, from /proc. No /proc (macOS): nothing to show.
    try {
      const kids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map((d) => {
        try {
          const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
          const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return Number(after[1]) === Number(pid) ? { pid: Number(d), start: Number(after[19]), cmd: fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim() } : null;
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => a.start - b.start);
      if (kids[0]) r = { pid: kids[0].pid, cmd: kids[0].cmd.slice(0, 300) };
    } catch {}
    childCache.set(pid, { at: Date.now(), r });
    return r;
  }
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | Where-Object Name -ne 'conhost.exe' | Sort-Object CreationDate | Select-Object -First 1 | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`], { encoding: "utf8", windowsHide: true }).trim();
    const m = out.match(/^(\d+) ([\s\S]*)$/);
    if (m) r = { pid: Number(m[1]), cmd: m[2].slice(0, 300) };
  } catch {}
  childCache.set(pid, { at: Date.now(), r });
  return r;
}
// End the step a stuck agent is waiting on. The agent carries on from there.
function unstick(f, pid) {
  const st = readState(f.slug);
  childCache.clear();
  const c = childOf(st.headlessPid || st.pid);
  if (!c || c.pid !== Number(pid)) return { ok: false, msg: "That step has already finished." };
  killTree(c.pid);
  childCache.clear();
  return { ok: true, msg: "Ended that step. The agent carries on from there." };
}
// End a stuck background turn. Its conversation is saved, so Carry on picks it up.
function stopTurn(f) {
  const st = readState(f.slug);
  if (!st.headlessPid) return { ok: false, msg: "No background turn to stop." };
  killTree(st.headlessPid);
  return { ok: true, msg: "Stopped the turn. Carry on picks it back up." };
}

function notes(f) {
  // A removed feature's folder is gone, but its notes were merged into main.
  // A dropped feature that was built still has its notes in its folder.
  const root = f.dir && !f.removed && fs.existsSync(path.join(f.dir, NOTES, f.slug)) ? f.dir : APP;
  const d = path.join(root, NOTES, f.slug);
  // A dropped feature that was never merged keeps its notes on its branch.
  const fromBranch = root === APP && f.branch && !fs.existsSync(path.join(d, "prompts.md")) && branchExists(f.branch);
  const r = (n) => {
    if (fromBranch) return tryGit(APP, "show", `${f.branch}:${NOTES}/${f.slug}/${n}`).out || "";
    try { return fs.readFileSync(path.join(d, n), "utf8"); } catch { return ""; }
  };
  return { from: fromBranch ? `branch ${f.branch}` : root === APP ? MAIN : f.branch, prompts: r("prompts.md"), log: r("log.md"), decisions: r("decisions.md") };
}

// Plugins Claude Code loads in every session on this machine (agents too).
// Only the enabledPlugins list is read from the user settings.
function userPlugins() {
  try { return Object.entries(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")).enabledPlugins || {}).filter(([, on]) => on).map(([k]) => k.split("@")[0]); } catch { return []; }
}

// Ponytail's own default level on this machine (its config file, else full).
function ponytailLevel() {
  const dir = process.env.APPDATA || path.join(os.homedir(), ".config");
  try { return JSON.parse(fs.readFileSync(path.join(dir, "ponytail", "config.json"), "utf8").replace(/^\uFEFF/, "")).defaultMode || "full"; } catch { return "full"; }
}

// ---------- http ----------

const body = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); });
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/api/features") return send(res, 200, await overview());
    // A short list for scripts and other agents (Hermes): what each feature
    // is, where it's at, and the start of its agent's last reply.
    if (req.method === "GET" && url.pathname === "/api/status") {
      const brief = (await overview()).map((f) => ({ slug: f.slug, title: f.title, status: f.status, label: f.label || "", agent: f.worktree ? f.live?.state || "" : "", activity: f.st?.activity || "", lastReply: String(f.st?.lastReply || "").slice(0, 600), queued: f.st?.queue?.length || 0, ahead: f.ahead || 0, pr: f.prInfo ? { number: f.pr, url: f.prUrl, state: f.prInfo.state, checks: f.prInfo.checks } : null, previewPort: f.worktree ? f.port : null }));
      return send(res, 200, brief);
    }
    if (req.method === "GET" && url.pathname === "/api/repo") return send(res, 200, { name: config.name, repo: APP, main: MAIN, ...repo(), agent: undefined, hasConfig: fs.existsSync(REPO_FILE), platform: process.platform });
    if (url.pathname === "/api/defaults") {
      if (req.method === "POST") {
        const b = await body(req);
        // Store only what differs from the built-in value, so improvements to
        // the built-in text reach anything the user hasn't changed.
        const keep = {};
        for (const k of Object.keys(BUILT_IN)) if (k in b && JSON.stringify(b[k]) !== JSON.stringify(BUILT_IN[k])) keep[k] = b[k];
        const raw = repoRaw();
        if (Object.keys(keep).length) raw.agent = keep; else delete raw.agent;
        fs.writeFileSync(REPO_FILE, JSON.stringify(raw, null, 2) + "\n");
        commitMain("Cannu: update the agent defaults", "cannu.json");
        for (const f of loadFeatures().filter(hasWorktree)) if (fs.existsSync(f.dir)) writeSettings(f); // new env
      }
      return send(res, 200, { values: defaults(), builtIn: BUILT_IN, models: MODELS, claudeDefault: claudeDefault(), plugins: userPlugins(), ponytailLevel: ponytailLevel() });
    }
    if (req.method === "POST" && url.pathname === "/api/features") {
      fresh();
      const { title, prompt, plan, model, label } = await body(req);
      if (!title?.trim()) return send(res, 400, { msg: "Needs a name." });
      if (!plan && !prompt?.trim()) return send(res, 400, { msg: "Needs a starting prompt to start an agent. Or save it as planned." });
      const lab = cleanLabel(label), l = readLabels();
      if (lab && !(lab in l)) newLabel(lab); // saved like any other, so its column stays if the feature leaves it
      return send(res, 200, createFeature(title.trim(), String(prompt || "").trim(), { refs: mentions(prompt), plan: !!plan, model, label: lab }));
    }
    // Continue every feature a usage limit held back.
    if (req.method === "POST" && url.pathname === "/api/continue") {
      fresh();
      const held = loadFeatures().filter((f) => hasWorktree(f) && readState(f.slug).state === "limited");
      const r = held.map((f) => continueHeld(f));
      return send(res, 200, { ok: r.every((x) => x.ok), msg: r.find((x) => !x.ok)?.msg || `Carrying on with ${held.length} ${held.length === 1 ? "task" : "tasks"}.` });
    }
    if (req.method === "GET" && url.pathname === "/api/labels") return send(res, 200, readLabels());
    // { name } plus, for edit, { to, description }. Errors come back as { msg }.
    const lm = req.method === "POST" && url.pathname.match(/^\/api\/labels\/(new|edit|duplicate|delete|order)$/);
    if (lm) {
      const b = await body(req), name = cleanLabel(b.name);
      fresh();
      try {
        if (lm[1] === "order") { orderLabels(b.names); return send(res, 200, { ok: true }); }
        if (lm[1] === "new") { newLabel(name, b.description, b.color); return send(res, 200, { ok: true }); }
        if (lm[1] === "edit") { editLabel(name, cleanLabel(b.to), b.description, b.color); return send(res, 200, { ok: true }); }
        return send(res, 200, lm[1] === "duplicate" ? duplicateLabel(name) : await deleteLabel(name));
      } catch (e) { return send(res, 200, { ok: false, msg: e.message }); }
    }
    const m = url.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/(\w+)$/);
    const f = m && loadFeatures().find((x) => x.slug === m[1]);
    if (!f) return send(res, 404, { msg: "Not found" });
    const action = m[2];
    if (req.method === "GET" && action === "notes") return send(res, 200, notes(f));
    if (req.method === "GET" && action === "chat") return send(res, 200, f.dir ? chat(f) : { messages: [] });
    if (req.method !== "POST") return send(res, 405, {});
    const b = await body(req);
    // Whatever this does, the next board shows it: cleared now, and again once
    // it finishes, since a long action (the check in Check and merge) lets
    // polls re-cache the old state in between.
    fresh(); res.on("finish", fresh);
    if (action === "reopen") {
      if (!b.title?.trim()) return send(res, 400, { msg: "Needs a title." });
      if (!b.plan && !b.prompt?.trim()) return send(res, 400, { msg: "Needs a prompt to start an agent. Or save it as planned." });
      const prompt = String(b.prompt || "").trim();
      return send(res, 200, createFeature(b.title.trim(), prompt, { continues: f.slug, refs: mentions(prompt, f.slug), plan: !!b.plan, model: b.model || "" }));
    }
    // One label per feature, any text. Empty clears it.
    if (action === "label") { setLabel(f, cleanLabel(b.label)); return send(res, 200, loadFeatures().find((x) => x.slug === f.slug)); }
    if (action === "drop") return send(res, 200, await dropFeature(f));
    if (action === "remove" && f.status === "dropped" && f.dir && !f.removed) return send(res, 200, await removeFeature(f));
    if (f.status === "planned") {
      if (action === "start") return send(res, 200, startFeature(f, `Start task: ${f.title}`));
      if (action === "edit") {
        const title = String(b.title || "").trim() || f.title;
        if (title !== f.title && loadFeatures().some((x) => x.slug !== f.slug && x.title.toLowerCase() === title.toLowerCase())) return send(res, 400, { msg: "A task already has that name." });
        const prompt = String(b.prompt ?? "").trim();
        const model = b.model === undefined ? f.model || "" : b.model in MODELS ? b.model : "";
        return send(res, 200, update(f.slug, { title, prompt, model, refs: mentions(prompt, f.slug) }, `Edit planned task: ${title}`));
      }
    }
    if (!hasWorktree(f)) return send(res, 400, { msg: "This task has no branch or agent. Start it, or Reopen it." });
    if (action === "open") {
      const live = liveStatus(readState(f.slug));
      // Two copies of one session would both write to it, so never open a second.
      if (live.open) return send(res, 200, { ok: false, msg: `It's already open in a terminal tab called "${f.slug}".` });
      if (live.background || running.has(f.slug)) return send(res, 200, { ok: false, msg: "It's working in the background. Open it once this turn finishes (the card will say idle), so there aren't two copies of the session." });
      return send(res, 200, openTab(f, "resume"));
    }
    if (action === "appstart") return send(res, 200, await startApp(f));
    if (action === "appstop") return send(res, 200, await stopApp(f));
    // The agent calls this with curl after changing code the server loads at start.
    if (action === "apprestart") { await stopApp(f); await new Promise((r) => setTimeout(r, 300)); return send(res, 200, await startApp(f)); }
    if (action === "feedback") return send(res, 200, feedback(f, String(b.text || "").trim()));
    if (action === "resume") return send(res, 200, resume(f, b.where));
    if (action === "continue") return send(res, 200, continueHeld(f));
    if (action === "retry") { startSetup(f); return send(res, 200, { ok: true }); }
    if (action === "unstick") return send(res, 200, unstick(f, b.pid));
    if (action === "stopturn") return send(res, 200, stopTurn(f));
    if (action === "merge") return send(res, 200, await merge(f));
    if (action === "pr") return send(res, 200, await openPR(f));
    if (action === "prmerge") return send(res, 200, f.pr ? await mergePR(f) : { ok: false, msg: "No pull request yet." });
    if (action === "remove") return send(res, 200, await removeFeature(f));
    send(res, 404, {});
  } catch (e) {
    send(res, 500, { msg: e.message });
  }
});
// Only server.js and this repo's agents talk to it, so localhost only.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`${config.name}: ${APP}${fs.existsSync(REPO_FILE) ? "" : " (no cannu.json, so built-in settings)"}`);
  for (const f of loadFeatures().filter(hasWorktree)) {
    // Point the worktree's hooks at this copy of the dashboard.
    if (fs.existsSync(f.dir)) writeSettings(f);
    // Pick up any setup a restart cut off.
    if (f.setup !== "ready" && !String(f.setup).startsWith("failed")) startSetup(f);
  }
});
