import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, resolveCredentials } from "./providers.js";
import {
  appendPending,
  claimPendingBatch,
  countIngest,
  migrateLegacyPending,
  paths,
  readProcedures,
  readProcessing,
  releaseGroomerLock,
  tryAcquireGroomerLock,
  unlinkWithRetry,
  writeJsonlAtomic,
} from "./store.js";

export const GROOM_MAX_ATTEMPTS = 3;

function logError(reflexDir, msg) {
  const logFile = path.join(reflexDir, "worker.log");
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`, "utf8");
  } catch {
    /* nowhere to log */
  }
}

function mergeStable(stable, batchIds, keptFromBatch) {
  const withoutBatch = stable.filter((n) => !n.id || !batchIds.has(n.id));
  const byId = new Map();
  const anonymous = [];
  for (const n of [...withoutBatch, ...keptFromBatch]) {
    if (n.id) byId.set(n.id, n);
    else anonymous.push(n);
  }
  return [...byId.values(), ...anonymous];
}

async function processBatch(reflexDir, processingFile, creds) {
  const batch = readProcessing(reflexDir);
  if (batch.length === 0) {
    unlinkWithRetry(processingFile);
    return { ok: true, deferred: 0 };
  }

  const prompt = `
Here are ${batch.length} new execution nodes/edges added by a coding agent.

<edges>
${JSON.stringify(batch, null, 2)}
</edges>

For each item:
1) Did the agent verify this worked? (e.g. ran a test, checked a log). If it just wrote code and blindly stopped without checking, it's risky.
2) Is this a generic/reusable workflow, or a one-off anomaly?
If it's unverified and risky, or a pure anomaly, decide to DROP it.
If it's good, KEEP it.

If you KEEP a root node (has no parent_id), generate 5-10 semantic aliases (synonyms) for its 'trigger' text so we can match variations of the user's prompt later.

Return ONLY a JSON array of objects with this schema:
[
  {
    "id": "node_id",
    "action": "KEEP" | "DROP",
    "aliases": ["alias1", "alias2"] // only if KEEP and root node
  }
]
`;

  let responseText;
  try {
    responseText = await PROVIDERS[creds.provider].complete(creds.apiKey, creds.model, prompt);
  } catch (err) {
    logError(reflexDir, err.message);
    return { ok: false, deferred: 0 };
  }

  let actions = [];
  try {
    const jsonStr = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    actions = JSON.parse(jsonStr);
  } catch {
    logError(reflexDir, "Failed to parse LLM JSON response.");
    return { ok: false, deferred: 0 };
  }

  const kept = [];
  const deferred = [];
  for (const node of batch) {
    const actionDef = actions.find((a) => a.id === node.id);
    if (!actionDef) {
      // No verdict from the model. Retry a few times, then give up on it.
      const attempts = (node.groom_attempts || 0) + 1;
      if (attempts < GROOM_MAX_ATTEMPTS) deferred.push({ ...node, groom_attempts: attempts });
      continue;
    }
    if (actionDef.action === "DROP") continue;
    const next = { ...node };
    delete next.status;
    delete next.groom_attempts;
    if (!next.parent_id && Array.isArray(actionDef.aliases)) {
      next.aliases = actionDef.aliases;
    }
    kept.push(next);
  }

  // Only remove ids we actually resolved; deferred ids stay out of stable.
  const resolvedIds = new Set(
    batch.filter((n) => actions.some((a) => a.id === n.id)).map((n) => n.id).filter(Boolean),
  );
  const merged = mergeStable(readProcedures(reflexDir), resolvedIds, kept);
  writeJsonlAtomic(paths(reflexDir).proceduresFile, merged);
  unlinkWithRetry(processingFile);

  for (const node of deferred) appendPending(reflexDir, node);
  return { ok: true, deferred: deferred.length };
}

/**
 * Compact pending → procedures. Single-flight. Safe vs concurrent hot-path appends.
 * @param {string} reflexDir path to .reflex/
 */
export async function runGroomer(reflexDir) {
  if (!tryAcquireGroomerLock(reflexDir)) return { ran: false, reason: "locked" };

  try {
    migrateLegacyPending(reflexDir);

    let creds;
    try {
      creds = resolveCredentials();
    } catch (e) {
      logError(reflexDir, e.message);
      return { ran: false, reason: "creds" };
    }
    if (!creds) {
      logError(
        reflexDir,
        "No API key found. Run `npx agent-procedures auth login` or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.",
      );
      return { ran: false, reason: "creds" };
    }

    let batches = 0;
    while (batches < 8) {
      const processingFile = claimPendingBatch(reflexDir);
      if (!processingFile) break;
      const { ok, deferred } = await processBatch(reflexDir, processingFile, creds);
      if (!ok) break;
      batches++;
      // Deferred rows were written back to pending; don't spin on the same ids.
      if (deferred > 0) break;
      if (countIngest(reflexDir) === 0) break;
    }
    return { ran: true, batches };
  } finally {
    releaseGroomerLock(reflexDir);
  }
}
