import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = {
  version: 1,
  harness: "cursor",
  recall: true,
  capture: true,
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

function ensureGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = ".reflex/";

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${entry}\n`, "utf8");
    return "created";
  }

  const current = fs.readFileSync(gitignorePath, "utf8");
  const lines = current.split(/\r?\n/);
  const alreadyIgnored = lines.some(
    (line) => line.trim() === ".reflex/" || line.trim() === ".reflex"
  );

  if (alreadyIgnored) {
    return "exists";
  }

  const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  fs.writeFileSync(gitignorePath, `${current}${suffix}${entry}\n`, "utf8");
  return "updated";
}

export function init(cwd = process.cwd()) {
  const reflexDir = path.join(cwd, ".reflex");
  const results = {
    dir: ensureDir(reflexDir),
    config: writeIfMissing(
      path.join(reflexDir, "config.json"),
      `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`
    ),
    procedures: writeIfMissing(path.join(reflexDir, "procedures.jsonl"), ""),
    runs: writeIfMissing(path.join(reflexDir, "runs.jsonl"), ""),
    gitignore: ensureGitignore(cwd),
  };

  return results;
}
