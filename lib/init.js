import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerSource } from "./runner.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  version: 1,
  harness: "claude",
  minConfidence: 0.7,
  store: {
    procedures: "procedures.jsonl",
    runs: "runs.jsonl",
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return "created";
  }
  return "exists";
}

function writeIfMissing(filePath, contents) {
  if (fs.existsSync(filePath)) {
    return "skipped";
  }
  fs.writeFileSync(filePath, contents, "utf8");
  return "created";
}

function writeAlways(filePath, contents) {
  fs.writeFileSync(filePath, contents, "utf8");
  return "updated";
}

function ensureGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = ".reflex/traces/";

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${entry}\n`, "utf8");
    return "created";
  }

  const current = fs.readFileSync(gitignorePath, "utf8");
  const lines = current.split(/\r?\n/);
  const alreadyIgnored = lines.some(
    (line) =>
      line.trim() === ".reflex/traces/" || line.trim() === ".reflex/traces",
  );

  if (alreadyIgnored) {
    return "exists";
  }

  const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  fs.writeFileSync(gitignorePath, `${current}${suffix}${entry}\n`, "utf8");
  return "updated";
}

function setupHooks(cwd) {
  const claudeDir = path.join(cwd, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");

  ensureDir(claudeDir);
  ensureDir(hooksDir);

  const runnerPath = path.join(hooksDir, "reflex.mjs");
  writeAlways(runnerPath, runnerSource);
  fs.chmodSync(runnerPath, 0o755);

  // The hook imports these relative to itself; npx doesn't leave the package in node_modules.
  for (const f of ["groomer.js", "providers.js"]) {
    fs.copyFileSync(path.join(LIB_DIR, f), path.join(hooksDir, f));
  }

  const settingsPath = path.join(claudeDir, "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (e) {
      console.warn(
        "Failed to parse existing .claude/settings.json, overwriting...",
      );
    }
  }

  // Claude Code shape: settings.hooks.<Event>[] -> { hooks: [{ type: "command", command }] }
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const events = [
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ];
  for (const event of events) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }
    const command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/reflex.mjs" ${event}`;
    const alreadyWired = settings.hooks[event].some((group) =>
      (group.hooks || []).some((h) => h.command === command),
    );
    if (!alreadyWired) {
      settings.hooks[event].push({ hooks: [{ type: "command", command }] });
    }
  }

  fs.writeFileSync(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
    "utf8",
  );
  return "updated";
}

export function init(cwd = process.cwd()) {
  const reflexDir = path.join(cwd, ".reflex");
  const tracesDir = path.join(reflexDir, "traces");

  ensureDir(reflexDir);
  ensureDir(tracesDir);

  const results = {
    dir: "exists",
    config: writeIfMissing(
      path.join(reflexDir, "config.json"),
      `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
    ),
    procedures: writeIfMissing(path.join(reflexDir, "procedures.jsonl"), ""),
    runs: writeIfMissing(path.join(reflexDir, "runs.jsonl"), ""),
    gitignore: ensureGitignore(cwd),
    hooks: setupHooks(cwd),
  };

  return results;
}
