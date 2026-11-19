// Claude Code runs this on session and turn events in a feature worktree
// (wired up in that worktree's .claude/settings.local.json). It records
// what the agent is doing for the dashboard, and appends every message you
// send, word for word, to <notes>/<slug>/prompts.md. Before each tool call it
// refuses what lib.js's RULES forbid, unless the user allowed that call once.
// A failure in here must never block the session, so every one is swallowed.
import fs from "node:fs";
import path from "node:path";
import { findByDir, loadFeatures, writeState, stamp, AUTO, notesDir, readState, LIMIT_HIT, resumeText, broken, callKey } from "./lib.js";

// PreToolUse's answer to Claude Code. Written synchronously: the process exits straight after.
const decide = (permissionDecision, permissionDecisionReason) =>
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }));

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
  // By FEATURE_SLUG (set in the worktree's settings) first, so an agent that
  // cd's out of its folder is still known, and still held to the rules.
  const slug = process.env.FEATURE_SLUG;
  const f = (slug && loadFeatures().find((x) => x.slug === slug && x.dir)) || findByDir(h.cwd || process.cwd());
  if (!f) return;
  const headless = process.env.META_HEADLESS === "1";
  const base = { session_id: h.session_id, headless };
  switch (h.hook_event_name) {
    case "SessionStart":
      // A background turn is already "working" (set by the dashboard) and its
      // prompt lands next: marking it idle here made the dots blink off.
      writeState(f.slug, headless ? { ...base, started: true } : { ...base, state: "idle", activity: "", started: true });
      break;
    case "UserPromptSubmit": {
      // A new turn: any earlier Stop no longer explains this one (headless() has
      // already told the agent), and last turn's refusals are done with.
      writeState(f.slug, { ...base, state: "working", activity: "thinking", lastPrompt: h.prompt, stopped: null, denied: [], turnAt: Date.now() });
      const dir = notesDir(f);
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
      const st = readState(f.slug), key = callKey(h.tool_name, i);
      // Allow once is used up by the one call it was for.
      const pass = (st.passes || []).findIndex((p) => p.tool === h.tool_name && p.key === key);
      const why = pass < 0 ? broken(f, h.tool_name, i, h.cwd || f.dir) : "";
      writeState(f.slug, {
        ...base, state: "working", activity: `${h.tool_name} ${what}`.trim(),
        ...(pass >= 0 && { passes: st.passes.filter((_, n) => n !== pass) }),
        ...(why && { denied: [...(st.denied || []).filter((d) => !(d.tool === h.tool_name && d.key === key)), { tool: h.tool_name, key, why, hard: true }] }),
      });
      if (pass >= 0) decide("allow", "The user allowed this once from the dashboard.");
      else if (why) decide("deny", `Cannu blocks this: ${why}`);
      break;
    }
    case "Notification":
      // A terminal left open nudges "waiting for your input" a minute after each
      // turn. That's just idle (Stop already said so), not a question; as
      // needs-you it put merged features back to waiting.
      if (h.notification_type === "idle_prompt" || /waiting for your input/i.test(h.message || "")) break;
      writeState(f.slug, { ...base, state: "needs-you", activity: h.message || "waiting for you" });
      break;
    case "Stop": {
      // An Allow once made before this turn started was for this turn: drop it if unused.
      // One made during the turn is for the retry that's queued behind it.
      const st = readState(f.slug);
      writeState(f.slug, { ...base, state: "idle", activity: "", lastReply: h.last_assistant_message || lastReply(h.transcript_path), passes: (st.passes || []).filter((p) => p.at > (st.turnAt || 0)) });
      break;
    }
    // A terminal turn cut off by a usage limit: held, and the dashboard
    // carries it on in the background once the limit resets. Background turns
    // are caught by the dashboard itself.
    case "StopFailure":
      if (!headless && (h.error === "rate_limit" || LIMIT_HIT.test(String(h.last_assistant_message || h.error_details || ""))))
        writeState(f.slug, { ...base, state: "limited", activity: "", held: { text: resumeText(), label: "carrying on after the usage limit" }, limitResets: null, limitTried: Date.now() });
      else writeState(f.slug, { ...base, state: "idle", activity: "", lastReply: h.last_assistant_message || "" });
      break;
    case "SessionEnd":
      if (!headless && readState(f.slug).state !== "limited") writeState(f.slug, { ...base, state: "idle", activity: "" });
      break;
  }
}
