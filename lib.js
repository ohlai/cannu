// Shared paths, config and the feature list. Node built-ins only.
//
// Two config files:
// - config.json, next to this file and gitignored: this machine. Which repo,
//   where worktrees go, ports.
// - cannu.json, in the repo's root and committed there: how to set that repo
//   up, run it, check it and merge it, plus the agent defaults.
//
// Each feature is a folder on main, <notes>/<slug>/, and its feature.md
// (title, status, dates, what I asked for) is the record. It's in git, so it
// survives without the dashboard. Things only this machine needs (port,
// worktree folder, session ID, setup step) are in local/features.json.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const META = path.dirname(fileURLToPath(import.meta.url));
// config.json lists every repo. server.js starts one repo.js per repo and
// hands it CANNU_REPO (which one) and CANNU_PORT (its own internal port).
// Run by hand with neither set, the first repo is used.
export const CONFIG = path.resolve(process.env.CANNU_CONFIG || path.join(META, "config.json"));
if (!fs.existsSync(CONFIG)) { console.error(`No config at ${CONFIG}. Copy config.example.json to config.json and list your repos.`); process.exit(1); }
const abs = (p) => (p ? path.resolve(path.dirname(CONFIG), p) : "");
export const all = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
// Every repo, with its name and its own ports. Feature ports go up in blocks
// of 100 per repo so two repos never hand out the same one. server.js uses
// repoEntry for a repo added from the page.
export const repoEntry = (r, i) => ({
  name: r.name || path.basename(abs(r.repo)),
  dir: abs(r.repo),
  worktrees: abs(r.worktrees) || abs(r.repo) + "-worktrees",
  // Internal: each repo.js, on localhost. "internalPort" moves them (a preview
  // copy of Cannu sets it so it never meets the live one).
  port: (all.internalPort || (all.port || 4000) + 1) + i,
  firstFeaturePort: r.firstFeaturePort || (all.firstFeaturePort || 8100) + i * 100,
});
export const repos = (all.repos || [{ repo: all.repo }]).map(repoEntry);
const me = repos.find((r) => r.name === process.env.CANNU_REPO) || repos[0];
export const config = { host: "127.0.0.1", ...all, name: me.name, firstFeaturePort: me.firstFeaturePort, port: Number(process.env.CANNU_PORT) || me.port };
export const APP = me.dir;
export const WORKTREES = me.worktrees;
export const CLAUDE_SETTINGS = all.claudeSettings && fs.existsSync(abs(all.claudeSettings)) ? abs(all.claudeSettings) : "";
// Per repo, so repos never share ports, sessions or state.
const HOME = path.join(abs(all.stateDir || path.join(META, "local")), me.name);
export const STATE = path.join(HOME, "state");
export const FEEDBACK = path.join(HOME, "feedback");
const RUNTIME = path.join(HOME, "features.json");
fs.mkdirSync(STATE, { recursive: true });

// ---------- cannu.json ----------

export const REPO_FILE = path.join(APP, "cannu.json");
// JSON that may have // comments, as cannu.example.json does. Drops each //
// to the end of its line unless it's inside a string ("http://" stays).
export function parseJsonc(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === "\\") out += text[++i] ?? ""; else if (c === '"') inStr = false; }
    else if (c === '"') { inStr = true; out += c; }
    else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i + 1] !== "\n") i++;
    else out += c;
  }
  return JSON.parse(out);
}
// Saving from the page (Agent defaults, Add repo) rewrites the file as plain
// JSON, so comments in it don't survive that.
export function repoRaw() {
  try { return parseJsonc(fs.readFileSync(REPO_FILE, "utf8")); } catch { return {}; }
}
// With no check in cannu.json, the repo's package.json check or test script.
function packageCheck() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).scripts || {};
    return s.check ? "npm run check" : s.test ? "npm test" : "";
  } catch { return ""; }
}
// Read on every use, so edits to cannu.json apply without a restart (except
// main and notes, which are read once below).
export function repo() {
  const r = repoRaw();
  return { main: "main", notes: "notes/features", setup: [], copy: [], app: "", seed: [], merge: "local", agent: {}, ...r, check: r.check ?? packageCheck() };
}
export const MAIN = repo().main;
export const NOTES = repo().notes;
export const FEATURES_DIR = path.join(APP, NOTES);
// "commitNotes": false keeps feature notes out of git: they all live in the
// main folder (so removing a worktree loses nothing) and are git-excluded.
export const COMMIT_NOTES = repo().commitNotes !== false;
export const notesDir = (f) => path.join(COMMIT_NOTES && f.dir && !f.removed ? f.dir : APP, NOTES, f.slug);

// ---------- feature.md ----------

// Fields kept in feature.md, in the order they're written.
const FIELDS = ["Status", "Label", "Created", "Started", "Branch", "Model", "Merged", "Dropped", "Continues", "Related", "Imported"];
export const MD_KEYS = new Set([...FIELDS.map((k) => k.toLowerCase()), "title", "prompt", "refs"]);

export function parseFeatureMd(slug, text) {
  const t = text.replace(/\r\n/g, "\n");
  const head = t.split("\n## ")[0];
  const f = { slug, title: (head.match(/^# (.+)$/m) || [])[1]?.trim() || slug };
  for (const m of head.matchAll(/^- (\w+): (.*)$/gm)) if (FIELDS.includes(m[1])) f[m[1].toLowerCase()] = m[2].trim();
  f.refs = f.related ? f.related.split(/,\s*/).filter(Boolean) : [];
  f.continues ||= null;
  const p = t.indexOf("\n## What I asked for\n");
  if (p >= 0) f.prompt = t.slice(p + 21).split(/\n## /)[0].trim();
  return f;
}

export function featureMd(f) {
  const vals = { ...f, related: (f.refs || []).join(", ") };
  let s = `# ${f.title}\n\nKept by Cannu. Its notes are next to this file: \`prompts.md\` (everything I said, word for word), \`log.md\` and \`decisions.md\`.\n\n`;
  for (const k of FIELDS) if (vals[k.toLowerCase()]) s += `- ${k}: ${vals[k.toLowerCase()]}\n`;
  if (f.prompt) s += `\n## What I asked for\n\n${f.prompt}\n`;
  return s;
}

// ---------- the list ----------

function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME, "utf8")); } catch { return {}; }
}
export function saveRuntime(slug, patch) {
  const all = readRuntime();
  all[slug] = { ...all[slug], ...patch };
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(RUNTIME, JSON.stringify(all, null, 2));
}
// A deleted feature forgets this machine's runtime and state too, so a new
// feature that gets its slug starts clean.
export function forget(slug) {
  const all = readRuntime();
  delete all[slug];
  fs.writeFileSync(RUNTIME, JSON.stringify(all, null, 2));
  fs.rmSync(path.join(STATE, slug + ".json"), { force: true });
}

export function loadFeatures() {
  const rt = readRuntime();
  let slugs = [];
  try { slugs = fs.readdirSync(FEATURES_DIR).filter((s) => fs.existsSync(path.join(FEATURES_DIR, s, "feature.md"))); } catch {}
  return slugs.map((slug) => ({ ...rt[slug], ...parseFeatureMd(slug, fs.readFileSync(path.join(FEATURES_DIR, slug, "feature.md"), "utf8")) }));
}

export function findByDir(dir) {
  const d = path.resolve(dir).toLowerCase();
  return loadFeatures().find((f) => f.dir && (d === f.dir.toLowerCase() || d.startsWith(f.dir.toLowerCase() + path.sep)));
}
export function readState(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, slug + ".json"), "utf8")); } catch { return {}; }
}
export function writeState(slug, patch) {
  const s = { ...readState(slug), ...patch, at: new Date().toISOString() };
  fs.writeFileSync(path.join(STATE, slug + ".json"), JSON.stringify(s, null, 2));
  return s;
}
export const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Anything the dashboard adds to a prompt starts with this, so prompts.md
// shows what was Oli's words and what was added.
export const AUTO = "[Added by the dashboard, not my words]";

// ---------- agent defaults ----------

export const MODELS = { "": "Claude Code's default", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5", "claude-fable-5-1": "Fable 5.1" };
export const BUILT_IN = {
  model: "",
  systemPrompt: "",
  // Sent when Oli presses Carry on after an agent was cut off mid-turn.
  resumeText: "You were interrupted mid-turn (the dashboard or the PC restarted, or the session was closed). Check git status and your log.md, work out where you got to, then carry on with what you were doing.",
  // Agents held by a full usage limit carry on by themselves once it resets.
  // Off: their cards offer Carry on instead.
  autoContinue: true,
  // Sent when a session's saved conversation is gone and a new one starts. {title} and {slug} are filled in.
  freshText: "Feature: {title}. The previous Claude session for this feature can't be reopened, so this is a new one. Read {notes}/{slug}/prompts.md, log.md and decisions.md, and git log on this branch, then tell me in a few lines where the feature is up to and what's left, and wait for me.",
  // Filled into the chat box when Check and merge hits a conflict. {files} is filled in.
  conflictText: "Main has moved on and merging your branch conflicts in: {files}. Merge main into your branch, resolve the conflicts keeping both sides' intent, run the check, log what you did, and commit.",
  // What a background turn may do without asking. Anything else is refused and listed on the card.
  allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(echo:*)", "Bash(curl:*)", "Bash(node:*)", "Bash(npm:*)", "Bash(pnpm:*)"],
  disallowedTools: ["Bash(git push:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git reset:*)"],
  // Extra environment variables for every agent, e.g. PONYTAIL_DEFAULT_MODE=off.
  env: {},
};
export function defaults() {
  return { ...BUILT_IN, ...repo().agent };
}
export const fill = (t, vars) => t.replace(/{(\w+)}/g, (m, k) => (k in vars ? vars[k] : m));
export const resumeText = () => `${AUTO} ${defaults().resumeText}`;

// Whether a recorded claude PID is still a running claude. Hooks only say
// what an agent last reported; this says whether it's still alive. The name
// is checked too, since after a restart the PID can belong to anything.
let pidCache = { at: 0, pids: new Set() };
function winClaudePids() {
  if (Date.now() - pidCache.at < 1500) return pidCache.pids;
  let pids = new Set();
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq claude.exe"], { encoding: "utf8", windowsHide: true });
    pids = new Set([...out.matchAll(/^"claude\.exe","(\d+)"/gim)].map((m) => Number(m[1])));
  } catch {}
  pidCache = { at: Date.now(), pids };
  return pids;
}
export function claudeAlive(pid) {
  if (!pid) return false;
  if (process.platform === "win32") return winClaudePids().has(pid);
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("claude"); } catch {}
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } // macOS: no /proc
}
// Ends a process and everything it started. On Linux and macOS, Cannu starts
// processes detached, so each leads its own group and -pid ends the lot.
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
  } catch {}
}

// What the card should say, from the last hook report plus whether the
// processes are alive. open = a terminal session is running right now.
export function liveStatus(st, running = false) {
  const term = claudeAlive(st.pid);
  // running: the dashboard just started a background turn whose PID may not
  // be in the cached process list yet. Without it a sent message briefly read
  // as "interrupted" and fired a notification.
  const bg = running || claudeAlive(st.headlessPid);
  // With a known PID we trust it. Without one (a session started by hand,
  // not from the dashboard) fall back to "a hook fired in the last 90s".
  const recent = !st.pid && !st.headlessPid && st.at && Date.now() - new Date(st.at) < 90e3;
  let state = st.state || "";
  if ((state === "working" || state === "needs-you") && !term && !bg && !recent) state = "interrupted";
  if (state === "starting" && !term && !recent) state = st.started ? "interrupted" : "not-started";
  if (state === "idle" && !term && !bg) state = "closed";
  return { state, open: term, background: bg };
}

// ---------- Claude plan usage ----------

// The 5 hour and weekly limits, from the endpoint Claude's own apps read, with
// this machine's Claude Code login. Claude Code keeps that token fresh; if it
// has expired, or there's no login file (macOS keeps it in the keychain),
// usage is just unknown and nothing is held. Refreshed every minute.
// Every Cannu process on this machine (the dashboard, each repo, each feature's
// own copy) shares one reading through USAGE_FILE: one fetch a minute between
// them all, a rate limit backs them all off (retry-after, at least 1 min), and a restart shows
// the last reading straight away. Polling separately got the endpoint to
// refuse them all, and a restarted one then had nothing.
const USAGE_FILE = path.join(os.tmpdir(), "cannu-usage.json");
let usageNow = null;
async function readUsage(force = false) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch {}
  if (c.usage) usageNow = c.usage;
  if (Date.now() < (force ? c.backoff || 0 : c.next || 0)) return;
  const save = (o) => { try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ usage: usageNow, ...o })); } catch {} };
  save({ next: Date.now() + 55e3 }); // claimed: the others wait for this fetch
  try {
    const tok = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")).claudeAiOauth?.accessToken;
    if (!tok) return;
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", { headers: { authorization: `Bearer ${tok}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(10e3) });
    // Back off as long as it asks, at least a minute. A flat 5 minutes lost
    // every slot to anything polling the same login each minute (it sends retry-after: 0).
    if (r.status === 429) { const t = Date.now() + Math.max(60e3, (+r.headers.get("retry-after") || 0) * 1e3); return save({ next: t, backoff: t }); }
    if (!r.ok) return;
    const j = await r.json();
    // limits[] carries the severity the apps colour by; five_hour and seven_day are the fallback.
    const pick = (kind, old) => {
      const l = (j.limits || []).find((x) => x.kind === kind);
      if (l) return { percent: l.percent, severity: l.severity, resets: l.resets_at };
      return j[old] ? { percent: j[old].utilization, severity: "", resets: j[old].resets_at } : null;
    };
    usageNow = { session: pick("session", "five_hour"), weekly: pick("weekly_all", "seven_day"), at: Date.now() };
    save({ next: Date.now() + 55e3 });
  } catch {}
}
// Straight after a turn hits the limit: fetch now, unless rate limited.
export const refreshUsage = () => readUsage(true);
// Only server.js and repo.js watch it: hook.js and launch.js import this file
// too, and mustn't wait on a fetch. Checking the shared file is cheap, so
// every 20s; the fetch itself is still once a minute.
export function watchUsage() { readUsage(); setInterval(readUsage, 20e3); }
export function planUsage() { return usageNow; }
// How Claude words a turn cut off by a usage limit.
export const LIMIT_HIT = /usage limit|hit your (\w+ )?limit|limit reached|limit · resets/i;
// The limit that's full right now ({ which, resets }), or null. A reset time
// that has passed means it's free again, even before the next refresh.
export function fullLimit() {
  for (const which of ["session", "weekly"]) {
    const l = usageNow?.[which];
    if (l && l.percent >= 100 && !(Date.parse(l.resets) <= Date.now())) return { which, resets: l.resets };
  }
  return null;
}

// What every agent is told about how Cannu works, whatever the repo's own
// CLAUDE.md says. Fixed, because the dashboard relies on it.
export function brief(f) {
  const r = repo();
  return [
    `You are a feature agent started by Cannu, a dashboard that runs one agent per feature, each on its own branch and git worktree. Yours is "${f.title}" on branch ${f.branch}.`,
    `Commit your work on this branch as you go. Never push, switch branches or touch other worktrees: Cannu merges your branch or opens its pull request.`,
    COMMIT_NOTES
      ? `Keep notes in ${NOTES}/${f.slug}/: log.md for what you did, decisions.md for each decision and why. prompts.md there is written for you; never edit it.`
      : `Keep notes in ${notesDir(f)}: log.md for what you did, decisions.md for each decision and why. That folder is outside git on purpose, so never git add it. prompts.md there is written for you; never edit it.`,
    r.app && `Your own copy of the app runs at http://localhost:${f.port} (PORT, DATA_DIR and APP_URL are set). After changing code the server loads at start, restart it with: curl -s -X POST $CANNU_URL/api/features/${f.slug}/apprestart`,
    r.check && `Before you say you're done, run the check: ${r.check}`,
  ].filter(Boolean).join("\n");
}

// Args for every claude run the dashboard starts. The credentials file is
// passed by path, so Claude Code reads it and the dashboard never does. The
// model is the feature's own, else the default.
export function claudeBaseArgs(f) {
  const d = defaults();
  const model = f?.model || d.model;
  const sp = [brief(f), d.systemPrompt.trim()].filter(Boolean).join("\n\n");
  return [...(CLAUDE_SETTINGS ? ["--settings", CLAUDE_SETTINGS] : []), ...(model ? ["--model", model] : []), "--append-system-prompt", sp];
}
