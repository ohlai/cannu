// Cannu: one board for every repo. Starts a repo.js per repo listed in
// config.json, each on its own internal port, and serves the page in front of
// them. /r/<name>/api/... goes to that repo's repo.js. A repo that crashes or
// hangs only takes its own board down, and comes back on its own.
// Node built-ins only. Run: node server.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { META, CONFIG, all, repos, repoEntry,watchUsage, planUsage } from "./lib.js";
watchUsage();

const PORT = all.port || 4000;
const LOGS = path.join(META, "local");
fs.mkdirSync(LOGS, { recursive: true });

// If Cannu was started from inside a Claude Code session, drop the variables
// that would make every agent a child of that session.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(k)));

const kids = new Map(); // name -> { proc, since }
function start(r) {
  const log = fs.openSync(path.join(LOGS, `${r.name}.log`), "a");
  const proc = spawn(process.execPath, [path.join(META, "repo.js")], { env: { ...env, CANNU_REPO: r.name, CANNU_PORT: String(r.port) }, stdio: ["ignore", log, log], windowsHide: true });
  fs.closeSync(log);
  kids.set(r.name, { proc, since: Date.now() });
  proc.on("exit", (code) => {
    if (kids.get(r.name)?.proc !== proc) return;
    // Restart, but not in a tight loop if it dies at once (a bad cannu.json).
    const quick = Date.now() - kids.get(r.name).since < 5000;
    console.log(`${r.name} stopped (${code}), restarting${quick ? " in 30s" : ""}`);
    setTimeout(() => start(r), quick ? 30e3 : 500);
  });
}
for (const r of repos) {
  if (!fs.existsSync(path.join(r.dir, ".git"))) { console.log(`${r.name}: ${r.dir} isn't a git repo, skipped`); continue; }
  start(r);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const k of kids.values()) k.proc.kill(); process.exit(0); });

function proxy(req, res, r, rest) {
  const up = http.request({ host: "127.0.0.1", port: r.port, path: rest, method: req.method, headers: req.headers }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
  up.on("error", () => { if (!res.headersSent) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ msg: `${r.name} is starting or has stopped. Its log is local/${r.name}.log.` })); } });
  req.pipe(up);
}

const isRepo = (dir) => { try { return fs.existsSync(path.join(dir, ".git")); } catch { return false; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// Repos the page can offer in Add repo: git folders next to the ones already
// listed (their parent folders, one level down), that aren't listed yet. With
// none listed, the ones in CANNU_REPOS, else the home folder.
function found() {
  const out = new Map();
  const parents = repos.length ? new Set(repos.map((r) => path.dirname(r.dir))) : [process.env.CANNU_REPOS || os.homedir()];
  for (const parent of parents) {
    let names = []; try { names = fs.readdirSync(parent); } catch {}
    for (const n of names) {
      const dir = path.join(parent, n);
      if (isRepo(dir) && !repos.some((r) => same(r.dir, dir))) out.set(dir.toLowerCase(), { name: n, dir });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const cleanDir = (dir) => path.resolve(String(dir || "").trim().replace(/^["']|["']$/g, ""));
// The name is in addresses and folder names, so keep it plain.
const plainName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const gitIn = (dir, ...args) => { try { return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return ""; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// What Add repo shows for a folder: its cannu.json if it has one, otherwise a
// guess from what's in it, for the person to check before saving.
function inspect(dir) {
  dir = cleanDir(dir);
  if (!isRepo(dir)) return { ok: false, msg: "Not a git repo (no .git folder in it)." };
  const has = (f) => fs.existsSync(path.join(dir, f));
  const own = readJson(path.join(dir, "cannu.json"));
  // Cannu commits on its main branch and puts worktrees next to it, which a live container built from this folder wouldn't want.
  const warn = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml", "Dockerfile"].some(has) ? "This folder has a compose file or Dockerfile, so a live container may build from it. Cannu creates worktrees next to it and commits on its main branch." : "";
  const base = { warn, name: plainName(path.basename(dir)) || "repo", dir, listed: repos.some((r) => same(r.dir, dir)), hasConfig: !!own };
  if (own) return { ok: true, ...base, config: own };
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
  const runner = has("mise.toml") ? "mise exec -- " : "";
  const scripts = readJson(path.join(dir, "package.json"))?.scripts || {};
  const install = !has("package.json") ? "" : { pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", bun: "bun install", npm: has("package-lock.json") ? "npm ci" : "npm install" }[pm];
  const run = (s) => `${runner}${pm} run ${s}`;
  return { ok: true, ...base, config: {
    main: gitIn(dir, "symbolic-ref", "--short", "HEAD") || "main",
    setup: [...(runner ? ["mise trust -q mise.toml"] : []), ...(install ? [runner + install] : [])],
    copy: has(".env") ? [".env"] : [],
    app: scripts.start ? run("start") : scripts.dev ? run("dev") : has("server.js") ? "node server.js" : "",
    seed: [],
    check: scripts.check ? run("check") : scripts.test ? run("test") : "",
    merge: "local",
    commitNotes: true,
  } };
}

// Writes the form's settings into the repo's cannu.json, keeping anything
// else already there (agent defaults, notes folder), and commits just that
// file if the repo is on its main branch. Says what it did.
const FORM = ["main", "setup", "copy", "app", "seed", "check", "merge", "commitNotes"];
function writeRepoConfig(dir, settings) {
  const file = path.join(dir, "cannu.json");
  const before = readJson(file) || {};
  const next = { ...before };
  for (const k of FORM) if (k in settings) next[k] = settings[k];
  // Leave out what's only the default, so the file says what's special here.
  // check stays even when empty: "" means no check, not the package's script.
  const DEF = { main: "main", setup: [], copy: [], app: "", seed: [], merge: "local", commitNotes: true };
  for (const [k, v] of Object.entries(DEF)) if (JSON.stringify(next[k]) === JSON.stringify(v)) delete next[k];
  if (JSON.stringify(next) === JSON.stringify(before)) return "";
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  if (gitIn(dir, "branch", "--show-current") !== (next.main || "main")) return " Saved cannu.json in it, not committed because it isn't on its main branch.";
  // The repo's own identity, else the last commit's author, as repo.js does.
  const who = (gitIn(dir, "log", "-1", "--format=%an|%ae") || "Cannu|cannu@localhost").split("|");
  const id = ["-c", `user.name=${gitIn(dir, "config", "user.name") || who[0]}`, "-c", `user.email=${gitIn(dir, "config", "user.email") || who[1]}`];
  gitIn(dir, "add", "--", "cannu.json");
  gitIn(dir, ...id, "commit", "-q", "-m", "Cannu: how to set up, run and check this repo", "--", "cannu.json");
  return !gitIn(dir, "status", "--porcelain", "--", "cannu.json") ? " Saved and committed its cannu.json." : " Saved cannu.json in it, but couldn't commit it.";
}

// Adds a repo to config.json and starts its Cannu, without a restart.
function addRepo(dir, wanted, settings) {
  dir = cleanDir(dir);
  if (!isRepo(dir)) return { ok: false, msg: `${dir} isn't a git repo (no .git folder in it).` };
  if (repos.some((r) => same(r.dir, dir))) return { ok: false, msg: "That repo is already listed." };
  const base = plainName(wanted || path.basename(dir)) || "repo";
  let name = base;
  for (let n = 2; repos.some((r) => r.name === name); n++) name = `${base}-${n}`;
  const note = settings ? writeRepoConfig(dir, settings) : "";
  const raw = readJson(CONFIG) || {};
  raw.repos ||= raw.repo ? [{ repo: raw.repo }] : [];
  delete raw.repo;
  // Ports clear of every running repo, and the feature ports kept in config
  // so they stay put when other repos are removed.
  const r = repoEntry({ repo: dir, name }, raw.repos.length);
  while (repos.some((x) => x.port === r.port)) r.port++;
  while (repos.some((x) => x.firstFeaturePort === r.firstFeaturePort)) r.firstFeaturePort += 100;
  raw.repos.push({ repo: path.relative(path.dirname(CONFIG), dir).replaceAll(path.sep, "/") || ".", name, firstFeaturePort: r.firstFeaturePort });
  fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2) + "\n");
  repos.push(r);
  start(r);
  return { ok: true, name, msg: `Added ${name}.${note}` };
}

// Takes a repo off the board. Nothing on disk is deleted: the repo, its
// worktrees, its notes and Cannu's own state for it all stay, so adding it
// back picks up where it was.
async function removeRepo(name) {
  const r = repos.find((x) => x.name === name);
  if (!r) return { ok: false, msg: "No repo by that name." };
  if (kids.has(name)) {
    const list = await fetch(`http://127.0.0.1:${r.port}/api/features`).then((x) => x.json()).catch(() => []);
    const busy = list.filter((f) => f.settingUp || ["working", "needs-you", "stuck"].includes(f.live?.state));
    if (busy.length) return { ok: false, msg: `An agent is still working in ${name} (${busy.map((f) => f.title).join(", ")}). Let it finish first.` };
    // Its previews would otherwise keep running with nothing to stop them.
    for (const f of list.filter((x) => x.appUp)) await fetch(`http://127.0.0.1:${r.port}/api/features/${f.slug}/appstop`, { method: "POST", body: "{}" }).catch(() => {});
    const k = kids.get(name);
    kids.delete(name); // first, so its exit isn't taken as a crash to restart
    k.proc.kill();
  }
  const raw = readJson(CONFIG) || {};
  raw.repos = (raw.repos || []).filter((x) => !same(path.resolve(path.dirname(CONFIG), x.repo), r.dir));
  fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2) + "\n");
  repos.splice(repos.indexOf(r), 1);
  return { ok: true, msg: `Removed ${name} from Cannu. Nothing on disk was deleted.` };
}
const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); });
const json = (res, obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const handler = async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(META, "index.html")));
  }
  if (url.pathname === "/logo.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    return res.end(fs.readFileSync(path.join(META, "logo.png")));
  }
  if (url.pathname === "/docs/images/logo-silk.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    return res.end(fs.readFileSync(path.join(META, "docs/images/logo-silk.png")));
  }
  // Claude plan usage for the rings: one account for every repo, so served here.
  if (url.pathname === "/api/usage") return json(res, planUsage());
  if (url.pathname === "/api/repos/found") return json(res, found());
  if (url.pathname === "/api/repos/inspect") return json(res, inspect(url.searchParams.get("dir")));
  if (url.pathname === "/api/repos/remove" && req.method === "POST") return json(res, await removeRepo((await readBody(req)).name));
  if (url.pathname === "/api/repos" && req.method === "POST") {
    const b = await readBody(req);
    return json(res, addRepo(b.dir, b.name, b.settings));
  }
  if (url.pathname === "/api/repos") return json(res, repos.filter((r) => kids.has(r.name)).map((r) => ({ name: r.name, dir: r.dir })));
  const m = url.pathname.match(/^\/r\/([^/]+)(\/.*)$/);
  const r = m && repos.find((x) => x.name === decodeURIComponent(m[1]));
  if (r && kids.has(r.name)) return proxy(req, res, r, m[2] + url.search);
  // The old single-repo address (/api/...), which older CLAUDE.md files tell
  // agents to curl, goes to the first repo.
  if (url.pathname.startsWith("/api/") && repos[0] && kids.has(repos[0].name)) return proxy(req, res, repos[0], url.pathname + url.search);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ msg: "Not found" }));
};

// Cannu has no login, and it can start agents that run commands, so it only
// listens where it's told: localhost by default. "host" can be a list, such
// as localhost plus a Tailscale address. By default it listens on IPv6
// localhost too: browsers try "localhost" as ::1 first, and on Windows a
// refused ::1 cost every new connection about 200ms before falling back.
const hosts = all.host ? [all.host].flat() : ["127.0.0.1", "::1"];
for (const h of hosts) http.createServer(handler).on("error", (e) => console.log(`Couldn't listen on ${h}: ${e.code}`)).listen(PORT, h);
console.log(`Cannu on http://localhost:${PORT} for ${repos.map((r) => r.name).join(", ")}`);
