import fs from "node:fs";
import path from "node:path";

// Cursor adapter. Everything Cursor-specific lives here.
// Docs: https://cursor.com/docs/hooks
// beforeSubmitPrompt → additional_context is undocumented but verified on Cursor 3.22.x.

const EVENTS = ["beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "stop"];

function toolTarget(tool, input) {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : "";
  if (tool === "Shell" || tool === "Bash" || tool === "bash") return input.command || "";
  return input.target || input.file_path || input.path || "";
}

/** Cursor Shell → engine Bash so command sanitization still applies. */
function normalizeToolName(tool) {
  if (tool === "Shell") return "Bash";
  return tool || "";
}

export default {
  id: "cursor",

  /** Where the generated hook shim goes, relative to the repo root. */
  hookFile: ".cursor/hooks/reflex.mjs",

  /** Merge our hooks into .cursor/hooks.json without touching anything else. */
  register(cwd) {
    const settingsPath = path.join(cwd, ".cursor", "hooks.json");
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch (e) {
        console.warn("Failed to parse existing .cursor/hooks.json, overwriting...");
      }
    }
    settings.version = settings.version || 1;
    settings.hooks = settings.hooks || {};

    // Cursor's hook shell often lacks nvm on PATH; bake the node that ran init.
    const node = process.execPath;

    for (const event of EVENTS) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      const command = `"${node}" ${this.hookFile} ${event}`;
      const wired = settings.hooks[event].some((h) => h && h.command === command);
      if (!wired) settings.hooks[event].push({ command });
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  },

  /** Cursor's stdin payload → normalized engine event, or null to ignore. */
  normalize(eventName, payload) {
    const name = payload.hook_event_name || eventName;
    const sessionId = payload.conversation_id || payload.session_id;
    const promptId = payload.generation_id || payload.prompt_id;
    const base = { sessionId, promptId };

    if (name === "beforeSubmitPrompt") {
      return { type: "prompt", ...base, prompt: payload.prompt || "" };
    }
    if (name === "postToolUse" || name === "postToolUseFailure") {
      const rawTool = payload.tool_name || "";
      const tool = normalizeToolName(rawTool);
      const input = payload.tool_input || {};
      return {
        type: "tool",
        ...base,
        tool,
        target: toolTarget(rawTool, input),
        ok: name === "postToolUse",
      };
    }
    if (name === "stop") {
      return {
        type: "stop",
        ...base,
        interrupted: payload.status === "aborted",
        busy: false,
      };
    }
    return null;
  },

  /** Engine result → what to print on stdout for Cursor. */
  render(evt, result) {
    if (evt.type !== "prompt") return "";
    const out = { continue: true };
    if (result.context) {
      // No Claude-style systemMessage on continue:true; put the notice in model context.
      out.additional_context = result.notice
        ? `${result.notice}\n\n${result.context}`
        : result.context;
    }
    return JSON.stringify(out);
  },
};
