// A feature's own copy of Cannu, for Preview. It runs this folder's
// server.js on PORT against a demo repo in DATA_DIR, never your real repos:
// a copy pointed at them would rewrite their worktree hooks and fight the
// live Cannu. The demo repo is made once, with features in every status and a
// few labels, so the board, list and label views all have something on them.
// Its features are planned, merged or dropped, so no agent runs until you
// press Start agent in the preview (which would run a real one, on the demo).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const PORT = Number(process.env.PORT) || 4100;
const DATA = path.resolve(process.env.DATA_DIR || "data");
const demo = path.join(DATA, "demo");
const git = (...a) => execFileSync("git", ["-c", "user.name=Cannu demo", "-c", "user.email=demo@localhost", ...a], { cwd: demo, stdio: "ignore" });

if (!fs.existsSync(path.join(demo, ".git"))) {
  fs.mkdirSync(demo, { recursive: true });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(demo, "README.md"), "# Demo repo\n\nMade by Cannu's preview. Safe to delete.\n");
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) + " 10:00";
  const features = [
    ["Dark mode", "planned", "Design", "", "Follow the system setting, with a manual override in settings."],
    ["Search features", "planned", "", "", "Search titles and descriptions from the top bar."],
    ["Onboarding tour", "planned", "Design", "", "A three-step tour the first time someone opens the app."],
    ["CSV export", "merged", "Data", "merged", "Export the current table as CSV."],
    ["Faster board", "merged", "Performance", "merged", "Cache what the board reads between polls."],
    ["Weekly email digest", "dropped", "Data", "dropped", "Email a summary every Monday. Dropped: nobody asked for it."],
  ];
  features.forEach(([title, status, label, when, prompt], i) => {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const dir = path.join(demo, "notes", "features", slug);
    fs.mkdirSync(dir, { recursive: true });
    const fields = [`- Status: ${status}`, label && `- Label: ${label}`, `- Created: ${day(9 - i)}`, when === "merged" && `- Merged: ${day(3 - i / 2)}`, when === "dropped" && `- Dropped: ${day(2)}`].filter(Boolean);
    fs.writeFileSync(path.join(dir, "feature.md"), `# ${title}\n\nKept by Cannu.\n\n${fields.join("\n")}\n\n## What I asked for\n\n${prompt}\n`);
  });
  git("add", "-A");
  git("commit", "-q", "-m", "Demo repo for Cannu's preview");
}

// Its own config: the board on PORT, its repo.js well away from the feature
// ports, and its state in DATA_DIR.
const config = path.join(DATA, "config.json");
fs.writeFileSync(config, JSON.stringify({ port: PORT, internalPort: PORT + 10000, firstFeaturePort: PORT + 20000, stateDir: path.join(DATA, "state"), repos: [{ repo: demo, name: "demo" }] }, null, 2));
const child = spawn(process.execPath, ["server.js"], { stdio: "inherit", env: { ...process.env, CANNU_CONFIG: config } });
child.on("exit", (c) => process.exit(c ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill());
