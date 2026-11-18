// Checks lib.js's hard RULES block what they should and nothing else.
// Run: node scripts/rules-check.js
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.CANNU_CONFIG ||= path.join(root, "config.example.json");
const { broken, ruleFor, notesDir } = await import("../lib.js");

const dir = path.resolve("/wt/demo"); // not under the temp folder, which agents may write to
const f = { slug: "demo", dir, branch: "feat/demo" };
const bash = (command, cwd = dir) => broken(f, "Bash", { command }, cwd);
const write = (file_path) => broken(f, "Write", { file_path });

for (const ok of ["git status", "git merge main", "git commit -m \"don't git push yet\"", "git branch --show-current", "git restore x.js",
  "git config --get user.name", "npm test", "rm -rf build", "git reset --hard HEAD~1", "curl -s -X POST $CANNU_URL/api/features/demo/apprestart", "echo high five"])
  assert.equal(bash(ok), "", ok);
for (const no of ["git push origin main", "gh pr merge 3", "cd x && git checkout main", "git switch -c x", "git branch -D feat/other", "git branch -f main HEAD",
  "git update-ref refs/heads/main HEAD", "git stash pop", "git worktree remove ../other", "git -C ../cannu commit -m x", "git config user.name x",
  "curl -X POST $CANNU_URL/api/defaults"])
  assert.notEqual(bash(no), "", no);
assert.notEqual(bash("git status", path.dirname(dir)), "", "git outside its folder");

assert.equal(write(path.join(dir, "src", "a.js")), "");
assert.equal(write(path.join(notesDir(f), "log.md")), "");
assert.equal(write(path.join(os.tmpdir(), "scratch.txt")), "");
assert.notEqual(write(path.join(notesDir(f), "prompts.md")), "");
assert.notEqual(write(path.join(dir, ".claude", "settings.local.json")), "");
assert.notEqual(write(path.join(path.dirname(dir), "other", "a.js")), "");
assert.equal(broken(f, "Read", { file_path: "C:/anywhere.txt" }), "", "reading is fine");

assert.equal(ruleFor("Bash", { command: "git restore x" }), "Bash(git restore:*)");
assert.equal(ruleFor("Bash", { command: "rm -rf build" }), "Bash(rm:*)");
assert.equal(ruleFor("WebFetch", { url: "x" }), "WebFetch");
console.log("rules ok");
