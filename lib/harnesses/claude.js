import fs from "node:fs";
import path from "node:path";

// Claude Code adapter. Everything Claude-specific lives here.
// Docs: https://code.claude.com/docs/en/hooks

const EVENTS = ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"];

export default {
  id: "claude",

  /** Where the generated hook shim goes, relative to the repo root. */
  hookFile: ".claude/hooks/reflex.mjs",

  /** Merge our hooks into .claude/settings.json without touching anything else. */
  register(cwd) {
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch (e) {
        console.warn("Failed to parse existing .claude/settings.json, overwriting...");
      }
    }
    settings.hooks = settings.hooks || {};

    for (const event of EVENTS) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      const command = `node "$CLAUDE_PROJECT_DIR/${this.hookFile}" ${event}`;
      const wired = settings.hooks[event].some((g) => (g.hooks || []).some((h) => h.command === command));
      if (!wired) settings.hooks[event].push({ hooks: [{ type: "command", command }] });
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  },

  /** Claude's stdin payload → normalized engine event, or null to ignore. */
  normalize(eventName, payload) {
    const name = payload.hook_event_name || eventName;
    const base = { sessionId: payload.session_id, promptId: payload.prompt_id };

    if (name === "UserPromptSubmit") {
      return { type: "prompt", ...base, prompt: payload.prompt };
    }
    if (name === "PostToolUse" || name === "PostToolUseFailure") {
      const tool = payload.tool_name;
      const input = payload.tool_input || {};
      let target = "";
      if (tool === "Bash" || tool === "bash") target = input.command || "";
      else if (typeof input === "string") target = input;
      else target = input.target || input.file_path || input.path || "";
      return { type: "tool", ...base, tool, target, ok: name === "PostToolUse" };
    }
    if (name === "Stop") {
      // stop_hook_active is a Stop-hook loop guard, not a user cancel.
      // Claude's Stop does not fire on interrupt, so there is no interrupt signal here.
      return {
        type: "stop",
        ...base,
        interrupted: false,
        busy: Array.isArray(payload.background_tasks) && payload.background_tasks.length > 0,
        reply: payload.last_assistant_message,
      };
    }
    return null;
  },

  /** Engine result → what to print on stdout for Claude. */
  render(evt, result) {
    if (evt.type !== "prompt") return "";
    if (!result.context) return "{}";
    const out = {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.context },
    };
    // Top-level systemMessage is shown to the user; not model context.
    if (result.notice) out.systemMessage = result.notice;
    return JSON.stringify(out);
  },
};
