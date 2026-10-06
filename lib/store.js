import fs from "node:fs";
import path from "node:path";

// Disk layout under .reflex/. Harness-free.
// Hot path appends pending.jsonl. Stable memory is procedures.jsonl.
// Groomer renames pending → processing, then merges into procedures.

export const GROOM_LOCK_STALE_MS = 15 * 60 * 1000;

export function paths(reflexDir) {
  return {
    reflexDir,
    tracesDir: path.join(reflexDir, "traces"),
    sessionsDir: path.join(reflexDir, "sessions"),
    proceduresFile: path.join(reflexDir, "procedures.jsonl"),
    pendingFile: path.join(reflexDir, "pending.jsonl"),
    processingFile: path.join(reflexDir, "processing.jsonl"),
    groomerLockFile: path.join(reflexDir, "groomer.lock"),
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(from, to, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const retryable = e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
      if (!retryable || i === attempts - 1) throw e;
      sleepSync(15 * (i + 1));
    }
  }
}

export function unlinkWithRetry(file, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    } catch (e) {
      const retryable = e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
      if (!retryable || i === attempts - 1) throw e;
      sleepSync(15 * (i + 1));
    }
  }
}

export function writeJsonlAtomic(file, nodes) {
  const content = nodes.length ? nodes.map((n) => JSON.stringify(n)).join("\n") + "\n" : "";
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  renameWithRetry(tmp, file);
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
  } catch {
    /* missing is fine */
  }
}

// Session scratchpad: one append-only file per conversation, so concurrent
// chats never share a file. Never read by the groomer; Stop copies the window
// into the pending row.
export const SESSION_WINDOW_TURNS = 5;
export const SESSION_TEXT_MAX = 3000;
export const SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function sessionFile(reflexDir, sessionId) {
  return path.join(paths(reflexDir).sessionsDir, `${sessionId}.jsonl`);
}

export function appendSessionTurn(reflexDir, sessionId, promptId, role, text) {
  const file = sessionFile(reflexDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = { gen: promptId, role, text: String(text).slice(0, SESSION_TEXT_MAX) };
  fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
}

/** Last N turns, oldest first. Within a turn, the latest line per role wins. */
export function readSessionWindow(reflexDir, sessionId, turns = SESSION_WINDOW_TURNS) {
  const byGen = new Map();
  for (const l of readJsonl(sessionFile(reflexDir, sessionId))) {
    if (!byGen.has(l.gen)) byGen.set(l.gen, {});
    byGen.get(l.gen)[l.role] = l.text;
  }
  const window = [];
  for (const turn of [...byGen.values()].slice(-turns)) {
    if (turn.user !== undefined) window.push({ role: "user", text: turn.user });
    if (turn.agent !== undefined) window.push({ role: "agent", text: turn.agent });
  }
  return window;
}

export function pruneStaleSessions(reflexDir, now = Date.now()) {
  const dir = paths(reflexDir).sessionsDir;
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SESSION_STALE_MS) fs.unlinkSync(file);
    } catch {
      /* raced with a hot-path append or another prune */
    }
  }
}

export function readProcedures(reflexDir) {
  return readJsonl(paths(reflexDir).proceduresFile);
}

export function readPending(reflexDir) {
  return readJsonl(paths(reflexDir).pendingFile);
}

export function readProcessing(reflexDir) {
  return readJsonl(paths(reflexDir).processingFile);
}

export function countIngest(reflexDir) {
  return readPending(reflexDir).length + readProcessing(reflexDir).length;
}

/** Hot path only. Never writes procedures.jsonl. */
export function appendPending(reflexDir, node) {
  const file = paths(reflexDir).pendingFile;
  fs.mkdirSync(reflexDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(node) + "\n", "utf8");
}

/**
 * Move legacy pending_review rows out of procedures.jsonl into pending.jsonl.
 * Safe to call repeatedly.
 */
export function migrateLegacyPending(reflexDir) {
  const p = paths(reflexDir);
  if (!fs.existsSync(p.proceduresFile)) return { moved: 0 };
  const nodes = readJsonl(p.proceduresFile);
  const pending = nodes.filter((n) => n.status === "pending_review");
  if (pending.length === 0) return { moved: 0 };
  const stable = nodes.filter((n) => n.status !== "pending_review");
  for (const node of pending) appendPending(reflexDir, node);
  writeJsonlAtomic(p.proceduresFile, stable);
  return { moved: pending.length };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

export function isGroomerLocked(reflexDir, now = Date.now()) {
  const lockFile = paths(reflexDir).groomerLockFile;
  if (!fs.existsSync(lockFile)) return false;
  const lock = readLock(lockFile);
  if (!lock) return false;
  const age = typeof lock.startedAt === "number" ? now - lock.startedAt : Infinity;
  if (age >= GROOM_LOCK_STALE_MS) return false;
  return pidAlive(lock.pid);
}

/** Exclusive create. Returns true if this process owns the lock. */
export function tryAcquireGroomerLock(reflexDir, now = Date.now()) {
  const lockFile = paths(reflexDir).groomerLockFile;
  fs.mkdirSync(reflexDir, { recursive: true });

  if (fs.existsSync(lockFile)) {
    if (isGroomerLocked(reflexDir, now)) return false;
    try {
      fs.unlinkSync(lockFile);
    } catch {
      return false;
    }
  }

  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }) + "\n", "utf8");
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

export function releaseGroomerLock(reflexDir) {
  const lockFile = paths(reflexDir).groomerLockFile;
  try {
    const lock = readLock(lockFile);
    if (lock && lock.pid !== process.pid) return;
    fs.unlinkSync(lockFile);
  } catch {
    /* missing is fine */
  }
}

/** Claim current pending batch for the groomer. Returns processing path or null. */
export function claimPendingBatch(reflexDir) {
  const { pendingFile, processingFile } = paths(reflexDir);
  if (fs.existsSync(processingFile)) return processingFile;
  if (!fs.existsSync(pendingFile)) return null;
  const stat = fs.statSync(pendingFile);
  if (stat.size === 0) {
    unlinkWithRetry(pendingFile);
    return null;
  }
  renameWithRetry(pendingFile, processingFile);
  return processingFile;
}
