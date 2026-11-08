// Claude Code runs this on session and turn events in a feature worktree
// (wired up in that worktree's .claude/settings.local.json). It records
// what the agent is doing for the dashboard, and appends every message Oli
// sends, word for word, to notes/features/<slug>/prompts.md.
// It must never block the session, so every failure is swallowed.
import fs from "node:fs";
import path from "node:path";
import { findByDir, writeState, readState, stamp, AUTO } from "./lib.js";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try { run(JSON.parse(raw || "{}")); } catch {}
  process.exit(0);
});

function lastReply(transcript) {
  try {
    const lines = fs.readFileSync(transcript, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = JSON.parse(lines[i]);
      if (m.type !== "assistant") continue;
      const text = (m.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) return text;
    }
  } catch {}
  return "";
}

function run(h) {
  const f = findByDir(h.cwd || process.cwd());
  if (!f) return;
  const headless = process.env.META_HEADLESS === "1";
  const base = { session_id: h.session_id, headless };
  switch (h.hook_event_name) {
    case "SessionStart":
      writeState(f.slug, { ...base, state: "idle", activity: "", started: true });
      break;
    case "UserPromptSubmit": {
      writeState(f.slug, { ...base, state: "working", activity: "thinking", lastPrompt: h.prompt });
      const dir = path.join(f.dir, "notes", "features", f.slug);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "prompts.md");
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${f.title}: everything I said\n\nWritten by a hook, word for word. Never edited.\n`);
      const via = h.prompt.startsWith(AUTO) ? "dashboard, automatic" : process.env.META_VIA || (headless ? "dashboard" : "terminal");
      fs.appendFileSync(file, `\n## ${stamp()} (${via})\n\n${h.prompt}\n`);
      break;
    }
    case "PreToolUse": {
      const i = h.tool_input || {};
      const what = i.file_path ? path.basename(i.file_path) : i.command ? String(i.command).slice(0, 80) : i.pattern || "";
      writeState(f.slug, { ...base, state: "working", activity: `${h.tool_name} ${what}`.trim() });
      break;
    }
    case "Notification":
      writeState(f.slug, { ...base, state: "needs-you", activity: h.message || "waiting for you" });
      break;
    case "Stop":
      writeState(f.slug, { ...base, state: "idle", activity: "", lastReply: h.last_assistant_message || lastReply(h.transcript_path) });
      break;
    case "SessionEnd":
      if (!headless) writeState(f.slug, { ...base, state: "idle", activity: "" });
      break;
  }
}
