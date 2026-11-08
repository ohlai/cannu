// Feature agents dashboard: which agent is on which feature, plus Add, Plan,
// Open, Feedback, Resume, Merge, Reopen. Node built-ins only. Not part of
// the app. Run: node server.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CLAUDE_SETTINGS, META, APP, WORKTREES, STATE, FEATURES_DIR, DEFAULTS_FILE, BUILT_IN, MODELS, defaults, fill, MD_KEYS, config, loadFeatures, saveRuntime, featureMd, readState, writeState, stamp, claudeBaseArgs, liveStatus, AUTO, resumeText, FEEDBACK } from "./lib.js";

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
// Commits use the repo's own identity if set, else the author of the last
// commit, so the dashboard never changes git config.
const author = (() => {
  const get = (k) => { try { return execFileSync("git", ["config", k], { cwd: APP, encoding: "utf8" }).trim(); } catch { return ""; } };
  const [n, e] = execFileSync("git", ["log", "-1", "--format=%an|%ae"], { cwd: APP, encoding: "utf8" }).trim().split("|");
  return { name: get("user.name") || n, email: get("user.email") || e };
})();

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, windowsHide: true });
    opts.onSpawn?.(p.pid);
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    if (opts.input != null) { p.stdin.end(opts.input); }
    const t = opts.timeout ? setTimeout(() => p.kill(), opts.timeout) : null;
    p.on("close", (code) => { if (t) clearTimeout(t); resolve({ code, out }); });
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
  });
}
const mise = (cwd, args, extra = {}) => run("mise", ["exec", "--", ...args], { cwd, ...extra });

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
  if (git(APP, "branch", "--show-current") !== "main") throw new Error("The app folder isn't on main, so the dashboard can't record this. Switch it back to main.");
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
  commitMain(message, path.join("notes", "features", f.slug, "feature.md"));
}
const registered = (dir) => tryGit(APP, "worktree", "list", "--porcelain").out.toLowerCase().replace(/\\/g, "/").includes(dir.toLowerCase().replace(/\\/g, "/"));
const branchExists = (b) => tryGit(APP, "rev-parse", "--verify", "-q", `refs/heads/${b}`).ok;

function openTab(f, mode) {
  if (config.noTabs) return;
  // A new Windows Terminal tab running launch.js, which starts claude with
  // the right args. wt can't focus a tab that's already open.
  spawn("wt.exe", ["-w", "0", "nt", "--title", f.slug, "-d", f.dir, "node", path.join(META, "launch.js"), f.slug, mode], { detached: true, stdio: "ignore" }).unref();
}

// ---------- pointing an agent at other features' notes ----------

// Where an agent can read a feature's notes. If it was merged before `since`
// (when the asking feature branched), the notes are already in the asking
// branch. Otherwise point at wherever they live now.
function notesRef(t, since) {
  if (t.status === "building" && t.dir) return path.join(t.dir, "notes", "features", t.slug) + path.sep;
  if (t.merged && since && t.merged >= since) return path.join(APP, "notes", "features", t.slug) + path.sep;
  return `notes/features/${t.slug}/`; // on main before this branch started, so in it too
}
function describe(t, since) {
  const status = t.status === "building" ? `not merged yet, on ${t.branch}` : t.merged ? `merged ${day(t.merged)}` : t.status;
  return `- "${t.title}" (${status}): read ${notesRef(t, since)} (prompts.md, log.md, decisions.md)`;
}
// Text added after Oli's own words, clearly marked, so prompts.md keeps
// exactly what Oli wrote. Only the starting prompt passes a title.
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
function createFeature(title, prompt, { continues = null, refs = [], plan = false, model = "" } = {}) {
  const list = loadFeatures();
  if (list.some((f) => f.title.toLowerCase() === title.toLowerCase())) throw new Error("A feature already has that name. Pick another.");
  const base = slugify(title);
  let slug = base;
  for (let n = 2; list.some((f) => f.slug === slug) || fs.existsSync(path.join(FEATURES_DIR, slug)) || fs.existsSync(path.join(WORKTREES, slug)) || branchExists(`feat/${slug}`); n++) slug = `${base}-${n}`;
  const f = { slug, title, prompt, status: "planned", created: stamp(), continues, refs, model: model in MODELS ? model : "" };
  if (plan) { writeFeature(f, `Plan feature: ${title}`); return f; }
  return startFeature(f, `Start feature: ${title}`);
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
function writeSettings(f) {
  fs.mkdirSync(path.join(f.dir, ".claude"), { recursive: true });
  const hook = () => ({ hooks: [{ type: "command", command: `node "${path.join(META, "hook.js")}"`, timeout: 10 }] });
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"];
  fs.writeFileSync(path.join(f.dir, ".claude", "settings.local.json"), JSON.stringify({
    env: {
      ...defaults().env, // Oli's extra variables; the ones below win, the dashboard relies on them
      FEATURE_SLUG: f.slug, PORT: String(f.port), DATA_DIR: path.join(f.dir, "data"), APP_URL: `http://localhost:${f.port}`,
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
    else git(APP, "worktree", "add", "-q", f.dir, "-b", f.branch, "main");
  }

  const data = path.join(f.dir, "data");
  writeSettings(f);

  step("copying data");
  fs.mkdirSync(data, { recursive: true });
  const src = path.join(APP, "data", "app.db");
  const dst = path.join(data, "app.db");
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    const tmp = dst + ".partial";
    fs.rmSync(tmp, { force: true });
    const db = new DatabaseSync(src, { readOnly: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    db.close();
    fs.renameSync(tmp, dst);
  }
  const up = path.join(APP, "data", "uploads");
  if (fs.existsSync(up)) fs.cpSync(up, path.join(data, "uploads"), { recursive: true, force: false });

  step("installing packages");
  await run("mise", ["trust", "-q", path.join(f.dir, "mise.toml")], { cwd: f.dir });
  const inst = await mise(f.dir, ["pnpm", "install", "--frozen-lockfile"], { timeout: 300000 });
  if (inst.code !== 0) throw new Error("pnpm install failed: " + tail(inst.out, 400));

  // Jack and the demo logins (oli@ / jack@, demo1234), whatever main's
  // database had. The tables come from the app's server.js, so start it
  // first. The seed is idempotent, so a retry or an already-seeded copy is fine.
  step("seeding demo data");
  await startApp(f);
  const seed = await run(process.execPath, ["scripts/seed-jack.js"], { cwd: f.dir, env: { ...process.env, DATA_DIR: path.join(f.dir, "data") }, timeout: 60000 });
  if (seed.code !== 0) throw new Error("seeding demo data failed: " + tail(seed.out, 400));

  step("ready");
  // Start the agent in the background. Open session shows it in a terminal.
  if (!readState(f.slug).started) {
    writeState(f.slug, { state: "starting", session_id: f.sessionId });
    headless(f, f.launchPrompt || f.prompt, "starting on your prompt", true);
  }
}

// ---------- talking to the agent ----------

// @slug in what Oli writes tags a related feature: the agent reads its notes.
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
function headless(f, text, label, first = false) {
  running.add(f.slug);
  const st = readState(f.slug);
  writeState(f.slug, { state: "working", activity: label, denied: [] });
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
    try { const j = JSON.parse(out.slice(out.indexOf("{"))); reply = j.result ?? reply; denied = (j.permission_denials || []).map((d) => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 120)}`); } catch {}
    writeState(f.slug, { state: code === 0 ? "idle" : "error", activity: "", headlessPid: null, lastReply: reply, denied });
    running.delete(f.slug);
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
  if (live.open && st.pid) {
    try { execFileSync("taskkill", ["/PID", String(st.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
    writeState(slug, { pid: null });
  }
  const [next, ...rest] = st.queue;
  writeState(slug, { queue: rest });
  headless(f, next, "your message from the dashboard");
  return "sent";
}
setInterval(() => { for (const f of loadFeatures()) if (readState(f.slug).queue?.length) pump(f.slug); }, 3000);

// The conversation so far, from Claude Code's saved transcript: what was
// sent, and the agent's last words in each turn.
function chat(f) {
  const st = readState(f.slug);
  const id = st.session_id || f.sessionId;
  const file = path.join(os.homedir(), ".claude", "projects", f.dir.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
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
  for (const q of st.queue || []) out.push({ who: "me", text: q, queued: true });
  return { messages: out.slice(-80), saved: lines.length > 1 };
}

function resume(f, where) {
  const live = liveStatus(readState(f.slug));
  if (live.open || live.background || running.has(f.slug)) return { ok: false, msg: "The agent is still running." };
  if (where === "terminal") { openTab(f, "continue"); return { ok: true, msg: "Opened a terminal tab that carries on." }; }
  if (!readState(f.slug).started) {
    if (where === "terminal") { openTab(f, "new"); return { ok: true, msg: "It never started, so I opened a terminal tab to start it." }; }
    headless(f, f.launchPrompt || f.prompt, "starting on your prompt", true);
    return { ok: true, msg: "Starting it in the background." };
  }
  headless(f, resumeText(), "carrying on after an interruption");
  return { ok: true, msg: "Carrying on in the background." };
}

// ---------- each feature's app ----------

// Whatever is listening on the port, whoever started it (the dashboard, the
// agent, or me by hand).
function listenerPid(port) {
  // netstat on this machine leaves out some listeners, and PowerShell shows
  // their State as blank, so take whichever process owns a socket on that
  // local port (only the server has one).
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Where-Object OwningProcess -gt 0 | Select-Object -First 1).OwningProcess`], { encoding: "utf8", windowsHide: true });
    return Number(out.trim()) || null;
  } catch { return null; }
}
const appLog = (f) => path.join(STATE, f.slug + "-app.log");

// Detached, so it keeps running if the dashboard restarts.
async function startApp(f) {
  if (await portUp(f.port)) return { ok: true, msg: "Already running." };
  const log = fs.openSync(appLog(f), "a");
  fs.writeSync(log, `\n--- ${stamp()} started from the dashboard ---\n`);
  spawn(process.execPath, ["server.js"], {
    cwd: f.dir, env: { ...process.env, PORT: String(f.port), DATA_DIR: path.join(f.dir, "data") },
    detached: true, windowsHide: true, stdio: ["ignore", log, log],
  }).unref();
  fs.closeSync(log);
  for (let i = 0; i < 50; i++) { if (await portUp(f.port)) return { ok: true, msg: "Started." }; await new Promise((r) => setTimeout(r, 200)); }
  return { ok: false, msg: "The app didn't start within 10 seconds. End of its log:\n" + tail(fs.readFileSync(appLog(f), "utf8"), 800) };
}
function stopApp(f) {
  const pid = listenerPid(f.port);
  if (!pid) return { ok: true, msg: "It wasn't running." };
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  return { ok: true, msg: "Stopped." };
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
  const dir = path.join(os.homedir(), ".claude", "projects", f.dir.replace(/[^A-Za-z0-9]/g, "-"));
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

async function merge(f) {
  // The hook appends to prompts.md after the agent's last commit, so commit it here.
  const pf = `notes/features/${f.slug}/prompts.md`;
  if (tryGit(f.dir, "status", "--porcelain", "--", pf).out) { git(f.dir, "add", pf); git(f.dir, "commit", "-q", "-m", `${f.title}: record prompts`); }
  if (tryGit(f.dir, "status", "--porcelain").out) return { ok: false, step: "feature", msg: "The feature has uncommitted changes. Ask the agent to commit first." };
  if (tryGit(APP, "status", "--porcelain").out) return { ok: false, step: "main", msg: "main has uncommitted changes in the app folder. Commit or stash them first." };
  if (git(APP, "branch", "--show-current") !== "main") return { ok: false, step: "main", msg: "The app folder isn't on main." };
  if (git(APP, "rev-list", "--count", `main..${f.branch}`) === "0") return { ok: false, step: "feature", msg: "Nothing to merge: the branch has no commits main doesn't have." };

  // Fresh server from the branch's committed code on a spare port, so a
  // stale server can't make the check pass.
  const port = f.port + 1000;
  const srv = spawn("node", ["server.js"], { cwd: f.dir, env: { ...process.env, PORT: String(port), DATA_DIR: path.join(f.dir, "data") }, windowsHide: true, stdio: "ignore" });
  let check;
  try {
    for (let i = 0; i < 50 && !(await portUp(port)); i++) await new Promise((r) => setTimeout(r, 200));
    check = await mise(f.dir, ["pnpm", "check"], { timeout: 300000, env: { ...process.env, APP_URL: `http://localhost:${port}` } });
  } finally { srv.kill(); }
  if (check.code !== 0) return { ok: false, step: "check", msg: "pnpm check failed on the feature branch.", out: tail(check.out) };

  const m = tryGit(APP, "merge", "--no-ff", "-q", f.branch, "-m", `Merge ${f.branch}: ${f.title}`);
  if (!m.ok) {
    const files = tryGit(APP, "diff", "--name-only", "--diff-filter=U").out;
    tryGit(APP, "merge", "--abort");
    const list = files.split("\n").filter(Boolean);
    return { ok: false, step: "conflict", msg: "Merging conflicts with main. Nothing was changed on main.", files: list, draft: fill(defaults().conflictText, { files: list.join(", ") }) };
  }
  update(f.slug, { status: "merged", merged: stamp() }, `Merged: ${f.title}`);
  return { ok: true, msg: `Merged into main. Not pushed.` };
}

// A bad idea, planned or part built. A built one's app stops, but its folder
// and branch stay (Remove worktree deletes the folder; an unmerged branch is
// kept), so the work isn't lost.
function dropFeature(f) {
  if (!["planned", "building"].includes(f.status)) return { ok: false, msg: "Only planned or building features can be dropped." };
  if (f.dir && !f.removed) {
    const live = liveStatus(readState(f.slug));
    if (live.open || live.background || running.has(f.slug) || settingUp.has(f.slug)) return { ok: false, msg: "The agent is still running. Let it finish or close its session first." };
    stopApp(f);
  }
  update(f.slug, { status: "dropped", dropped: stamp() }, `Dropped: ${f.title}`);
  return { ok: true, msg: "Dropped. It stays on record under Dropped." };
}

// Deletes the folder and branch but keeps the feature in the list. A merged
// feature's notes are on main from then on.
function removeFeature(f) {
  if (!f.merged && f.status !== "dropped") return { ok: false, msg: "Not merged yet. Merge it first, or drop it." };
  const live = liveStatus(readState(f.slug));
  if (live.open || live.background) return { ok: false, msg: "The agent is still running. Close its session first." };
  if (registered(f.dir)) {
    // A dropped feature's half-done work is committed to its branch, which is
    // kept, so deleting the folder loses nothing.
    if (f.status === "dropped" && tryGit(f.dir, "status", "--porcelain").out) { git(f.dir, "add", "-A"); git(f.dir, "commit", "-q", "-m", `${f.title}: dropped, work in progress kept`); }
    if (tryGit(f.dir, "status", "--porcelain").out) return { ok: false, msg: "The feature has uncommitted changes. Not removing." };
    stopApp(f); // a running app holds files in the folder
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
  return { ok: true, msg: (b.ok ? "Removed the worktree and branch. The feature and its notes stay in the list." : `Removed the worktree. The branch ${f.branch} is kept because it isn't merged, so its work and notes are still in git.`) + leftover };
}

// ---------- overview ----------

const hasWorktree = (f) => !!f.dir && !f.removed && f.status !== "planned" && f.status !== "dropped";

async function overview() {
  return Promise.all(loadFeatures().map(async (f) => {
    const st = readState(f.slug);
    // No worktree: planned, imported, dropped, or removed after merging.
    if (!hasWorktree(f)) return { ...f, st, worktree: false, live: { state: f.status }, usage: f.dir ? usage(f) : null };
    const exists = fs.existsSync(f.dir);
    const g = (...a) => (exists ? tryGit(f.dir, ...a).out : "");
    const ahead = exists ? Number(tryGit(APP, "rev-list", "--count", `main..${f.branch}`).out) || 0 : 0;
    const behind = exists ? Number(tryGit(APP, "rev-list", "--count", `${f.branch}..main`).out) || 0 : 0;
    const dirty = g("status", "--porcelain").split("\n").filter(Boolean).length;
    const lastCommit = g("log", "-1", "--format=%s (%cr)");
    let live = liveStatus(st, running.has(f.slug));
    const stuckInfo = stuck(f, st, live);
    if (stuckInfo) live = { ...live, state: "stuck" };
    return { ...f, st, live, stuck: stuckInfo, settingUp: settingUp.has(f.slug), ahead, behind, dirty, lastCommit, worktree: true, appUp: exists && (await portUp(f.port)), usage: usage(f) };
  }));
}

// A turn that's gone quiet: working, but no hook report and nothing written
// to its transcript for 3 minutes. Usually something it's waiting on has hung,
// like a hook that never returns. Says what's still running under the agent.
const QUIET = 3 * 60e3;
function stuck(f, st, live) {
  if (live.state !== "working") return null;
  const t = path.join(os.homedir(), ".claude", "projects", f.dir.replace(/[^A-Za-z0-9]/g, "-"), `${st.session_id || f.sessionId}.jsonl`);
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
  try { execFileSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  childCache.clear();
  return { ok: true, msg: "Ended that step. The agent carries on from there." };
}
// End a stuck background turn. Its conversation is saved, so Carry on picks it up.
function stopTurn(f) {
  const st = readState(f.slug);
  if (!st.headlessPid) return { ok: false, msg: "No background turn to stop." };
  try { execFileSync("taskkill", ["/PID", String(st.headlessPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  return { ok: true, msg: "Stopped the turn. Carry on picks it back up." };
}

function notes(f) {
  // A removed feature's folder is gone, but its notes were merged into main.
  // A dropped feature that was built still has its notes in its folder.
  const root = f.dir && !f.removed && fs.existsSync(path.join(f.dir, "notes", "features", f.slug)) ? f.dir : APP;
  const d = path.join(root, "notes", "features", f.slug);
  // A dropped feature that was never merged keeps its notes on its branch.
  const fromBranch = root === APP && f.branch && !fs.existsSync(path.join(d, "prompts.md")) && branchExists(f.branch);
  const r = (n) => {
    if (fromBranch) return tryGit(APP, "show", `${f.branch}:notes/features/${f.slug}/${n}`).out || "";
    try { return fs.readFileSync(path.join(d, n), "utf8"); } catch { return ""; }
  };
  return { from: fromBranch ? `branch ${f.branch}` : root === APP ? "main" : f.branch, prompts: r("prompts.md"), log: r("log.md"), decisions: r("decisions.md") };
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

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(META, "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/logo.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      return res.end(fs.readFileSync(path.join(META, "logo.png")));
    }
    if (req.method === "GET" && url.pathname === "/api/features") return send(res, 200, await overview());
    if (url.pathname === "/api/defaults") {
      if (req.method === "POST") {
        const b = await body(req);
        // Store only what differs from the built-in value, so improvements to
        // the built-in text reach anything Oli hasn't changed.
        const keep = {};
        for (const k of Object.keys(BUILT_IN)) if (k in b && JSON.stringify(b[k]) !== JSON.stringify(BUILT_IN[k])) keep[k] = b[k];
        fs.writeFileSync(DEFAULTS_FILE, JSON.stringify(keep, null, 2) + "\n");
        commitMain("Feature agents: update the agent defaults", path.relative(APP, DEFAULTS_FILE));
        for (const f of loadFeatures().filter(hasWorktree)) if (fs.existsSync(f.dir)) writeSettings(f); // new env
      }
      return send(res, 200, { values: defaults(), builtIn: BUILT_IN, models: MODELS, claudeDefault: claudeDefault(), plugins: userPlugins(), ponytailLevel: ponytailLevel() });
    }
    if (req.method === "POST" && url.pathname === "/api/features") {
      const { title, prompt, plan, model } = await body(req);
      if (!title?.trim()) return send(res, 400, { msg: "Needs a name." });
      if (!plan && !prompt?.trim()) return send(res, 400, { msg: "Needs a starting prompt to start an agent. Or save it as planned." });
      return send(res, 200, createFeature(title.trim(), String(prompt || "").trim(), { refs: mentions(prompt), plan: !!plan, model }));
    }
    const m = url.pathname.match(/^\/api\/features\/([a-z0-9-]+)\/(\w+)$/);
    const f = m && loadFeatures().find((x) => x.slug === m[1]);
    if (!f) return send(res, 404, { msg: "Not found" });
    const action = m[2];
    if (req.method === "GET" && action === "notes") return send(res, 200, notes(f));
    if (req.method === "GET" && action === "chat") return send(res, 200, f.dir ? chat(f) : { messages: [] });
    if (req.method !== "POST") return send(res, 405, {});
    const b = await body(req);
    if (action === "reopen") {
      if (!b.title?.trim()) return send(res, 400, { msg: "Needs a title." });
      if (!b.plan && !b.prompt?.trim()) return send(res, 400, { msg: "Needs a prompt to start an agent. Or save it as planned." });
      const prompt = String(b.prompt || "").trim();
      return send(res, 200, createFeature(b.title.trim(), prompt, { continues: f.slug, refs: mentions(prompt, f.slug), plan: !!b.plan }));
    }
    // One label per feature, any text. Empty clears it.
    if (action === "label") {
      const label = String(b.label || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return send(res, 200, update(f.slug, { label }, label ? `Label ${f.title}: ${label}` : `Unlabel ${f.title}`));
    }
    if (action === "drop") return send(res, 200, dropFeature(f));
    if (action === "remove" && f.status === "dropped" && f.dir && !f.removed) return send(res, 200, removeFeature(f));
    if (f.status === "planned") {
      if (action === "start") return send(res, 200, startFeature(f, `Start feature: ${f.title}`));
      if (action === "edit") {
        const title = String(b.title || "").trim() || f.title;
        if (title !== f.title && loadFeatures().some((x) => x.slug !== f.slug && x.title.toLowerCase() === title.toLowerCase())) return send(res, 400, { msg: "A feature already has that name." });
        const prompt = String(b.prompt ?? "").trim();
        return send(res, 200, update(f.slug, { title, prompt, refs: mentions(prompt, f.slug) }, `Edit planned feature: ${title}`));
      }
    }
    if (!hasWorktree(f)) return send(res, 400, { msg: "This feature has no branch or agent. Start it, or Reopen it." });
    if (action === "open") {
      const live = liveStatus(readState(f.slug));
      // Two copies of one session would both write to it, so never open a second.
      if (live.open) return send(res, 200, { ok: false, msg: `It's already open in a terminal tab called "${f.slug}".` });
      if (live.background || running.has(f.slug)) return send(res, 200, { ok: false, msg: "It's working in the background. Open it once this turn finishes (the card will say idle), so there aren't two copies of the session." });
      openTab(f, "resume");
      return send(res, 200, { ok: true, msg: "Opened a new terminal tab." });
    }
    if (action === "appstart") return send(res, 200, await startApp(f));
    if (action === "appstop") return send(res, 200, stopApp(f));
    // The agent calls this with curl after changing server.js.
    if (action === "apprestart") { stopApp(f); await new Promise((r) => setTimeout(r, 300)); return send(res, 200, await startApp(f)); }
    if (action === "feedback") return send(res, 200, feedback(f, String(b.text || "").trim()));
    if (action === "resume") return send(res, 200, resume(f, b.where));
    if (action === "retry") { startSetup(f); return send(res, 200, { ok: true }); }
    if (action === "unstick") return send(res, 200, unstick(f, b.pid));
    if (action === "stopturn") return send(res, 200, stopTurn(f));
    if (action === "merge") return send(res, 200, await merge(f));
    if (action === "remove") return send(res, 200, removeFeature(f));
    send(res, 404, {});
  } catch (e) {
    send(res, 500, { msg: e.message });
  }
}).listen(config.dashboardPort, "127.0.0.1", () => {
  console.log(`feature agents dashboard on http://localhost:${config.dashboardPort}`);
  for (const f of loadFeatures().filter(hasWorktree)) {
    // Point the worktree's hooks at this copy of the dashboard.
    if (fs.existsSync(f.dir)) writeSettings(f);
    // Pick up any setup a restart cut off.
    if (f.setup !== "ready" && !String(f.setup).startsWith("failed")) startSetup(f);
  }
});
