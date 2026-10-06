import {
  appendHit,
  appendPending,
  appendSessionTurn,
  appendTrace,
  countIngest,
  deleteTrace,
  readProcedures,
  readSessionWindow,
  readTrace,
  startTrace,
} from "./store.js";
import { sanitizeCommand, sanitizeText } from "./sanitize.js";
import { expandRecallQuery, recall } from "./recall.js";
import { coldEstTokens, countColdTools, savedTokens } from "./cost.js";

/**
 * Harness-free hot path.
 *
 * Normalized event (produced by a harness adapter):
 *   { type: "prompt", sessionId, promptId, prompt }
 *   { type: "tool",   sessionId, promptId, tool, target, ok }
 *   { type: "reply",  sessionId, promptId, text }
 *   { type: "stop",   sessionId, promptId, interrupted, busy, reply? }
 *
 * Returns { context: string | null, notice?: string | null }.
 * `context` is text the harness should inject into the agent's next turn.
 * `notice` is a short user-visible line; the harness maps it if the host supports it.
 */
export function handleEvent(evt, reflexDir, deps = {}) {
  if (!evt || !evt.sessionId || !evt.promptId) return { context: null };

  if (evt.type === "prompt") return onPrompt(evt, reflexDir);
  if (evt.type === "tool") return onTool(evt, reflexDir);
  if (evt.type === "reply") return onReply(evt, reflexDir);
  if (evt.type === "stop") return onStop(evt, reflexDir, deps);
  return { context: null };
}

export const GROOM_THRESHOLD = 5;
export const REDACTED_TEXT = "[REDACTED_UNRESOLVABLE_SECRET]";

// --- reply: session scratchpad only ---------------------------------------

// Must not touch the trace: a reply can land after Stop already deleted it.
function onReply(evt, reflexDir) {
  recordReply(evt, evt.text, reflexDir);
  return { context: null };
}

function recordReply(evt, text, reflexDir) {
  if (!text) return;
  const sanitized = sanitizeText(text);
  appendSessionTurn(
    reflexDir,
    evt.sessionId,
    evt.promptId,
    "agent",
    sanitized.unsafe ? REDACTED_TEXT : sanitized.text,
  );
}

// --- prompt: open turn + recall ------------------------------------------

function onPrompt(evt, reflexDir) {
  const { sessionId, promptId, prompt } = evt;
  const sanitized = sanitizeCommand(prompt);
  startTrace(reflexDir, sessionId, promptId, {
    t: "Goal",
    prompt: sanitized.text,
    ...(sanitized.requiresEnv.length > 0 ? { requires_env: sanitized.requiresEnv } : {}),
    ...(sanitized.unsafe ? { contains_unresolvable_secret: true } : {}),
  });
  appendSessionTurn(reflexDir, sessionId, promptId, "user", sanitized.unsafe ? REDACTED_TEXT : sanitized.text);

  const query = expandRecallQuery(sanitized.text, readSessionWindow(reflexDir, sessionId));
  const hit = recall(query, readProcedures(reflexDir));
  if (!hit) return { context: null, notice: null };

  appendTrace(reflexDir, sessionId, promptId, { t: "Recall", hit: hit.node.id });
  appendHit(reflexDir, {
    ts: new Date().toISOString(),
    session: sessionId,
    procedure: hit.node.id,
    trigger: hit.node.trigger || "",
    saved_tokens: savedTokens(hit.node, hit.text),
    steps: hit.node.steps || [],
  });
  return { context: hit.text, notice: hit.notice };
}

// --- tool: trace ----------------------------------------------------------

function onTool(evt, reflexDir) {
  const sanitized =
    evt.tool === "Bash" || evt.tool === "bash"
      ? sanitizeCommand(evt.target)
      : sanitizeText(evt.target);
  appendTrace(reflexDir, evt.sessionId, evt.promptId, {
    t: evt.tool,
    target: sanitized.text,
    ok: evt.ok,
    ...(sanitized.requiresEnv.length > 0 ? { requires_env: sanitized.requiresEnv } : {}),
    ...(sanitized.unsafe ? { contains_unresolvable_secret: true } : {}),
  });
  return { context: null };
}

// --- stop: judge → gate → synthesize → write ------------------------------

function onStop(evt, reflexDir, deps) {
  const { sessionId, promptId } = evt;
  recordReply(evt, evt.reply, reflexDir);
  const lines = readTrace(reflexDir, sessionId, promptId);
  if (lines.length === 0) return { context: null };
  if (lines.some((line) => line.contains_unresolvable_secret)) {
    deleteTrace(reflexDir, sessionId, promptId);
    return { context: null };
  }

  let goal = "";
  let recallHit = null;
  let hasGoal = false;
  for (const l of lines) {
    if (l.t === "Goal") {
      goal = l.prompt;
      hasGoal = true;
    }
    if (l.t === "Recall" && l.hit) recallHit = l.hit;
  }
  // Continuation after another Stop hook can recreate a trace via appendTrace
  // with no Goal line. Don't learn from that stump.
  if (!hasGoal) {
    deleteTrace(reflexDir, sessionId, promptId);
    return { context: null };
  }

  if (judge(lines, evt)) {
    const { steps, requiresEnv } = synthesize(lines);
    if (steps.length > 0) {
      const id = Math.random().toString(36).slice(2, 11);
      const cold_tools = countColdTools(lines);
      const cold_est_tokens = coldEstTokens(cold_tools, steps.length);
      if (!recallHit) {
        appendPending(reflexDir, {
          id,
          title: goal,
          trigger: goal,
          transcript: readSessionWindow(reflexDir, sessionId),
          steps,
          cold_tools,
          cold_est_tokens,
          ...(requiresEnv.length > 0 ? { requires_env: requiresEnv } : {}),
          enabled: true,
          created_at: new Date().toISOString(),
          status: "pending_review",
        });
      } else {
        const parent = readProcedures(reflexDir).find((p) => p.id === recallHit);
        const parentSteps = parent ? parent.steps : [];
        const same =
          parentSteps.length === steps.length &&
          parentSteps.every((s, i) => s.t === steps[i].t && s.target === steps[i].target);
        if (!same) {
          appendPending(reflexDir, {
            id,
            parent_id: recallHit,
            type: "alt",
            steps,
            ...(requiresEnv.length > 0 ? { requires_env: requiresEnv } : {}),
            created_at: new Date().toISOString(),
            status: "pending_review",
          });
        }
      }

      if (countIngest(reflexDir) >= GROOM_THRESHOLD && deps.spawnGroomer) deps.spawnGroomer();
    }
  }

  deleteTrace(reflexDir, sessionId, promptId);
  return { context: null };
}

const READ_ONLY_CMDS = ["cat", "ls", "git", "pwd", "head", "tail", "echo", "grep", "find"];
const PURE_READ_CMDS = ["cat", "ls", "pwd", "head", "tail"];
const VERIFY_RE = /\b(lint|eslint|tsc|typecheck|prettier|test|vitest|jest|mocha)\b/i;

function isVerifyCmd(t, target) {
  return (t === "Bash" || t === "bash") && VERIFY_RE.test(target || "");
}

function isMutating(t, target) {
  if (t === "Edit" || t === "Write" || t === "NotebookEdit") return true;
  if (t === "Bash" || t === "bash") {
    const cmd = (target || "").trim();
    if (!cmd) return false;
    const first = cmd.split(" ")[0];
    if (READ_ONLY_CMDS.includes(first)) {
      return first === "git" && /\s(commit|push|add|rm|mv)\b/.test(cmd);
    }
    return true;
  }
  return false;
}

function judge(lines, evt) {
  const steps = lines.filter((l) => l.t !== "Goal" && l.t !== "Recall");
  if (!steps.some((l) => isMutating(l.t, l.target))) return false;
  if (evt.interrupted || evt.busy) return false;

  const failed = [];
  for (const l of steps) {
    if (l.ok === false) failed.push(l);
    else if (l.ok === true) {
      for (let i = failed.length - 1; i >= 0; i--) {
        if (failed[i].t === l.t && failed[i].target === l.target) failed.splice(i, 1);
      }
    }
  }
  const hasGoodWrite = steps.some((l) => isMutating(l.t, l.target) && l.ok !== false);
  if (hasGoodWrite) {
    return failed.every((l) => isVerifyCmd(l.t, l.target));
  }
  return failed.length === 0;
}

function synthesize(lines) {
  const steps = [];
  const requiresEnv = new Set();
  for (const l of lines) {
    for (const name of l.requires_env || []) requiresEnv.add(name);
    if (l.t === "Goal" || l.t === "Recall" || l.ok === false) continue;
    if (l.t === "Read" || l.t === "View") continue;
    if (l.t === "Bash" || l.t === "bash") {
      const target = l.target || "";
      if (!target.trim()) continue;
      if (PURE_READ_CMDS.includes(target.trim().split(" ")[0])) continue;
      if (/^git (status|log|diff)/.test(target)) continue;
    }
    steps.push({ t: l.t, target: l.target });
  }
  return { steps, requiresEnv: [...requiresEnv] };
}
