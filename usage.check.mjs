// Check for the shared usage reading's back-off rules: node usage.check.mjs
// Runs against a throwaway temp dir with fetch stubbed, so it never calls Anthropic.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagecheck-"));
process.env.TMP = process.env.TEMP = process.env.TMPDIR = dir;
delete process.env.FEATURE_SLUG;
process.env.CANNU_CONFIG ??= new URL("./config.example.json", import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0);
let calls = 0;
globalThis.fetch = async () => { calls++; return { status: 200, ok: true, json: async () => ({ five_hour: { utilization: 42, resets_at: "x" } }) }; };
const lib = await import("./lib.js");
const f = path.join(dir, "cannu-usage.json");
// What older code writes after a 429 with a long retry-after, `age` ms ago.
const old = (age) => { const w = Date.now() + 35 * 60e3; fs.writeFileSync(f, JSON.stringify({ usage: null, next: w, backoff: w })); const t = (Date.now() - age) / 1e3; fs.utimesSync(f, t, t); };
old(60e3); await lib.refreshUsage(); assert.equal(calls, 0, "a long wait written a minute ago is obeyed");
old(6 * 60e3); await lib.refreshUsage(); assert.equal(calls, 1, "a long wait is ignored 5 min after it was written");
assert.equal(lib.planUsage().session.percent, 42);
process.env.FEATURE_SLUG = "x"; old(6 * 60e3); await lib.refreshUsage(); assert.equal(calls, 1, "feature app copies never fetch");
fs.rmSync(dir, { recursive: true });
console.log("usage check ok");
