import {
  appendProcedure,
  appendTrace,
  deleteTrace,
  readProcedures,
  readTrace,
  startTrace,
} from "./store.js";

/**
 * Harness-free hot path.
 *
 * Normalized event (produced by a harness adapter):
 *   { type: "prompt", sessionId, promptId, prompt }
 *   { type: "tool",   sessionId, promptId, tool, target, ok }
 *   { type: "stop",   sessionId, promptId, interrupted, busy }
 *
 * Returns { context: string | null }. `context` is text the harness should
 * inject into the agent's next turn, if it knows how.
 */
export function handleEvent(evt, reflexDir, deps = {}) {
  if (!evt || !evt.sessionId || !evt.promptId) return { context: null };

  if (evt.type === "prompt") return onPrompt(evt, reflexDir);
  if (evt.type === "tool") return onTool(evt, reflexDir);
  if (evt.type === "stop") return onStop(evt, reflexDir, deps);
  return { context: null };
}

export const GROOM_THRESHOLD = 5;

// --- prompt: open turn + recall ------------------------------------------

function onPrompt(evt, reflexDir) {
  const { sessionId, promptId, prompt } = evt;
  startTrace(reflexDir, sessionId, promptId, { t: "Goal", prompt });

  const hit = recall(prompt, readProcedures(reflexDir));
  if (!hit) return { context: null };

  appendTrace(reflexDir, sessionId, promptId, { t: "Recall", hit: hit.node.id });
  return { context: hit.text };
}

function recall(prompt, procs) {
  if (!prompt) return null;
  const p = prompt.toLowerCase();
  const fmt = (steps) => steps.map((s) => `- ${s.t}: ${s.target}`).join("\n");

  for (const node of procs) {
    if (node.enabled === false || node.parent_id) continue;

    let match = node.trigger && p.includes(node.trigger.toLowerCase());
    if (!match && Array.isArray(node.aliases)) {
      match = node.aliases.some((a) => p.includes(a.toLowerCase()));
    }
    if (!match) continue;

    let text = fmt(node.steps);
    const alt = procs.find((e) => e.parent_id === node.id && e.type === "alt" && e.enabled !== false);
    const onFail = procs.find((e) => e.parent_id === node.id && e.type === "on_fail" && e.enabled !== false);
    if (alt) text += "\n\nAlternative path that worked:\n" + fmt(alt.steps);
    if (onFail) text += "\n\nIf it fails, this recovery worked:\n" + fmt(onFail.steps);

    return {
      node,
      text: `Reflex memory found a procedure for this task:\n\n${text}\n\nFollow these steps instead of figuring it out from scratch.`,
    };
  }
  return null;
}

// --- tool: trace ----------------------------------------------------------

function onTool(evt, reflexDir) {
  appendTrace(reflexDir, evt.sessionId, evt.promptId, { t: evt.tool, target: evt.target || "", ok: evt.ok });
  return { context: null };
}

// --- stop: judge → gate → synthesize → write ------------------------------

function onStop(evt, reflexDir, deps) {
  const { sessionId, promptId } = evt;
  const lines = readTrace(reflexDir, sessionId, promptId);
  if (lines.length === 0) return { context: null };

  let goal = "";
  let recallHit = null;
  for (const l of lines) {
    if (l.t === "Goal") goal = l.prompt;
    if (l.t === "Recall" && l.hit) recallHit = l.hit;
  }

  if (judge(lines, evt)) {
    const steps = synthesize(lines);
    if (steps.length > 0) {
      if (!recallHit) {
        appendProcedure(reflexDir, {
          id: Math.random().toString(36).slice(2, 11),
          title: goal,
          trigger: goal,
          steps,
          enabled: true,
          hits: 0,
          last_used_at: new Date().toISOString(),
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
          appendProcedure(reflexDir, {
            parent_id: recallHit,
            type: "alt",
            steps,
            created_at: new Date().toISOString(),
            status: "pending_review",
          });
        }
      }

      const pending = readProcedures(reflexDir).filter((p) => p.status === "pending_review").length;
      if (pending >= GROOM_THRESHOLD && deps.spawnGroomer) deps.spawnGroomer();
    }
  }

  deleteTrace(reflexDir, sessionId, promptId);
  return { context: null };
}

const READ_ONLY_CMDS = ["cat", "ls", "git", "pwd", "head", "tail", "echo", "grep", "find"];
const PURE_READ_CMDS = ["cat", "ls", "pwd", "head", "tail"];

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

  const failed = new Set();
  for (const l of steps) {
    const key = `${l.t}|${l.target}`;
    if (l.ok === false) failed.add(key);
    else if (l.ok === true) failed.delete(key);
  }
  return failed.size === 0;
}

function synthesize(lines) {
  const steps = [];
  for (const l of lines) {
    if (l.t === "Goal" || l.t === "Recall" || l.ok === false) continue;
    if (l.t === "Read" || l.t === "View") continue;
    if (l.t === "Bash" || l.t === "bash") {
      const target = l.target || "";
      if (PURE_READ_CMDS.includes(target.trim().split(" ")[0])) continue;
      if (/^git (status|log|diff)/.test(target)) continue;
    }
    steps.push({ t: l.t, target: l.target });
  }
  return steps;
}
