import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, resolveCredentials } from "./providers.js";
import {
  appendPending,
  claimPendingBatch,
  countIngest,
  migrateLegacyPending,
  paths,
  pruneStaleSessions,
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

export function buildGroomPrompt(batch) {
  const items = batch.map(({ id, parent_id, trigger, transcript, steps }) => ({
    id,
    ...(parent_id ? { parent_id } : { trigger, transcript }),
    steps,
  }));
  return `
You review turns a coding agent completed, and turn the reusable ones into procedures a future agent can follow.

<turns>
${JSON.stringify(items, null, 2)}
</turns>

A root turn (no parent_id) has a transcript (recent conversation, oldest first; the last user message triggered the steps) and the steps the agent ran. "trigger" is the raw last user message. A turn with parent_id is an alternative path for an existing procedure.

For each turn:
1. Work out the real task from the whole transcript. The last user message is often just a reply like "yes" or "pick option A"; resolve it against what the agent offered. Earlier messages may be about a different task; name only the task these steps did.
2. KEEP if it's a pattern someone would ask for again (a kind of change plus how it was checked). DROP if it only makes sense once (a specific typo, a specific value).
3. If two root turns in this batch are the same task, KEEP the most complete one and DROP the others.
4. If KEEP:
   - Root turns only: "trigger" is a short imperative phrase (3-7 words) for the general task, never a conversational reply. "aliases" are 5-10 other ways a user would phrase the same task.
   - "steps": rewrite the steps so they apply to other instances of the task. Replace specific file paths with a description of which file (e.g. "the list page component"). Keep commands exact. Drop exploratory reads and searches.

Return ONLY a JSON array:
[{ "id": "...", "action": "KEEP" | "DROP", "trigger": "...", "aliases": ["..."], "steps": [{ "t": "...", "target": "..." }] }]
`;
}

function validSteps(steps) {
  return (
    Array.isArray(steps) &&
    steps.length > 0 &&
    steps.every((s) => s && typeof s.t === "string" && typeof s.target === "string")
  );
}

async function processBatch(reflexDir, processingFile, creds) {
  const batch = readProcessing(reflexDir);
  if (batch.length === 0) {
    unlinkWithRetry(processingFile);
    return { ok: true, deferred: 0 };
  }

  const prompt = buildGroomPrompt(batch);

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
  const resolvedIds = new Set();
  for (const node of batch) {
    const actionDef = actions.find((a) => a.id === node.id);
    // A kept root without a new trigger would keep the raw prompt ("pick option A").
    const missingTrigger =
      actionDef?.action === "KEEP" && !node.parent_id && !(typeof actionDef.trigger === "string" && actionDef.trigger.trim());
    if (!actionDef || missingTrigger) {
      // No usable verdict from the model. Retry a few times, then give up on it.
      const attempts = (node.groom_attempts || 0) + 1;
      if (attempts < GROOM_MAX_ATTEMPTS) deferred.push({ ...node, groom_attempts: attempts });
      continue;
    }
    if (node.id) resolvedIds.add(node.id);
    if (actionDef.action === "DROP") continue;
    const next = { ...node };
    delete next.status;
    delete next.groom_attempts;
    delete next.transcript;
    if (!next.parent_id) {
      next.trigger = actionDef.trigger.trim();
      next.title = next.trigger;
      if (Array.isArray(actionDef.aliases)) next.aliases = actionDef.aliases;
    }
    if (validSteps(actionDef.steps)) next.steps = actionDef.steps.map(({ t, target }) => ({ t, target }));
    kept.push(next);
  }

  // Only remove ids we actually resolved; deferred ids stay out of stable.
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
    pruneStaleSessions(reflexDir);

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
