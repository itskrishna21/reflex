import fs from "node:fs";
import path from "node:path";

// Disk layout under .reflex/. Harness-free.

export function paths(reflexDir) {
  return {
    reflexDir,
    tracesDir: path.join(reflexDir, "traces"),
    proceduresFile: path.join(reflexDir, "procedures.jsonl"),
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function traceFile(reflexDir, sessionId, promptId) {
  return path.join(paths(reflexDir).tracesDir, sessionId, `${promptId}.jsonl`);
}

export function startTrace(reflexDir, sessionId, promptId, goal) {
  const file = traceFile(reflexDir, sessionId, promptId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(goal) + "\n", "utf8");
}

export function appendTrace(reflexDir, sessionId, promptId, line) {
  const file = traceFile(reflexDir, sessionId, promptId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
}

export function readTrace(reflexDir, sessionId, promptId) {
  return readJsonl(traceFile(reflexDir, sessionId, promptId));
}

export function deleteTrace(reflexDir, sessionId, promptId) {
  try {
    fs.unlinkSync(traceFile(reflexDir, sessionId, promptId));
  } catch (e) {}
}

export function readProcedures(reflexDir) {
  return readJsonl(paths(reflexDir).proceduresFile);
}

export function appendProcedure(reflexDir, node) {
  const file = paths(reflexDir).proceduresFile;
  if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
  fs.appendFileSync(file, JSON.stringify(node) + "\n", "utf8");
}
