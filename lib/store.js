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
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
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

export function readProcedures(reflexDir) {
  return readJsonl(paths(reflexDir).proceduresFile);
}

export function readPending(reflexDir) {
  return readJsonl(paths(reflexDir).pendingFile);
}

export function readProcessing(reflexDir) {
  return readJsonl(paths(reflexDir).processingFile);
}

/** Stable + ingest buffer + any in-flight batch. Used by recall. */
export function readAllProcedures(reflexDir) {
  return [
    ...readProcedures(reflexDir),
    ...readPending(reflexDir),
    ...readProcessing(reflexDir),
  ];
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
