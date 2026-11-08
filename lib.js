// Shared paths and the feature list. Node built-ins only.
//
// Each feature is a folder on main, notes/features/<slug>/, and its
// feature.md (title, status, dates, what I asked for) is the record. It's in
// git, so it survives without the dashboard. Things only this machine needs
// (port, worktree folder, session ID, setup step) are in local/features.json,
// which is gitignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const META = path.dirname(fileURLToPath(import.meta.url));
// META_CONFIG points at another config (used to test on a throwaway clone).
const CONFIG = process.env.META_CONFIG ? path.resolve(process.env.META_CONFIG) : path.join(META, "config.json");
export const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const abs = (p) => (p ? path.resolve(path.dirname(CONFIG), p) : "");
export const APP = abs(config.appRepo);
export const WORKTREES = abs(config.worktrees);
export const CLAUDE_SETTINGS = config.claudeSettings && fs.existsSync(abs(config.claudeSettings)) ? abs(config.claudeSettings) : "";
const HOME = abs(config.stateDir || "local");
export const STATE = path.join(HOME, "state");
export const FEEDBACK = path.join(HOME, "feedback");
const RUNTIME = path.join(HOME, "features.json");
export const FEATURES_DIR = path.join(APP, "notes", "features");
// What every feature agent is given (model, system prompt, messages,
// permissions, extra environment). In git, next to this file. Only what Oli
// changed is stored; everything else comes from BUILT_IN below.
export const DEFAULTS_FILE = abs(config.defaultsFile || "agent-defaults.json");
fs.mkdirSync(STATE, { recursive: true });

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
  let s = `# ${f.title}\n\nKept by the feature agents dashboard (\`tools/cannu/\`). Its notes are next to this file: \`prompts.md\` (everything I said, word for word), \`log.md\` and \`decisions.md\`.\n\n`;
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
  // Sent when a session's saved conversation is gone and a new one starts. {title} and {slug} are filled in.
  freshText: "Feature: {title}. The previous Claude session for this feature can't be reopened, so this is a new one. Read notes/features/{slug}/prompts.md, log.md and decisions.md, and git log on this branch, then tell me in a few lines where the feature is up to and what's left, and wait for me.",
  // Filled into the chat box when Check and merge hits a conflict. {files} is filled in.
  conflictText: "Main has moved on and merging your branch conflicts in: {files}. Merge main into your branch, resolve the conflicts keeping both sides' intent, run the app and pnpm check, log what you did, and commit.",
  // What a background turn may do without asking. Anything else is refused and listed on the card.
  allowedTools: config.headlessAllowedTools || [],
  disallowedTools: config.headlessDisallowedTools || [],
  // Extra environment variables for every agent, e.g. PONYTAIL_DEFAULT_MODE=off.
  env: {},
};
export function defaults() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8")); } catch {}
  return { ...BUILT_IN, ...saved };
}
export const fill = (t, vars) => t.replace(/{(w+)}/g, (m, k) => (k in vars ? vars[k] : m));
export const resumeText = () => `${AUTO} ${defaults().resumeText}`;

// Which claude.exe processes are running right now, by PID. Hooks only say
// what an agent last reported; this says whether it's still alive.
let pidCache = { at: 0, pids: new Set() };
export function claudePids() {
  if (Date.now() - pidCache.at < 1500) return pidCache.pids;
  let pids = new Set();
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq claude.exe"], { encoding: "utf8", windowsHide: true });
    pids = new Set([...out.matchAll(/^"claude\.exe","(\d+)"/gim)].map((m) => Number(m[1])));
  } catch {}
  pidCache = { at: Date.now(), pids };
  return pids;
}

// What the card should say, from the last hook report plus whether the
// processes are alive. open = a terminal session is running right now.
export function liveStatus(st) {
  const pids = claudePids();
  const term = !!st.pid && pids.has(st.pid);
  const bg = !!st.headlessPid && pids.has(st.headlessPid);
  // With a known PID we trust it. Without one (a session started by hand,
  // not from the dashboard) fall back to "a hook fired in the last 90s".
  const recent = !st.pid && !st.headlessPid && st.at && Date.now() - new Date(st.at) < 90e3;
  let state = st.state || "";
  if ((state === "working" || state === "needs-you") && !term && !bg && !recent) state = "interrupted";
  if (state === "starting" && !term && !recent) state = st.started ? "interrupted" : "not-started";
  if (state === "idle" && !term && !bg) state = "closed";
  return { state, open: term, background: bg };
}

// Args for every claude run the dashboard starts. The credentials file is
// passed by path, so Claude Code reads it and the dashboard never does. The
// model is the feature's own, else the default.
export function claudeBaseArgs(f) {
  const d = defaults();
  const model = f?.model || d.model;
  const sp = d.systemPrompt.trim();
  return [...(CLAUDE_SETTINGS ? ["--settings", CLAUDE_SETTINGS] : []), ...(model ? ["--model", model] : []), ...(sp ? ["--append-system-prompt", sp] : [])];
}
