const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "in",
  "on",
  "please",
  "can",
  "you",
  "my",
  "this",
  "for",
  "with",
]);

export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function scoreTarget(promptTokens, targetString) {
  const targetTokens = tokenize(targetString);
  if (targetTokens.length === 0) return { coverage: 0, matchCount: 0, targetLen: 0 };

  let matchCount = 0;
  let hasHighValueWord = false;

  for (const tWord of targetTokens) {
    const isMatch = promptTokens.some(
      (pWord) => pWord === tWord || (tWord.length >= 3 && pWord.startsWith(tWord)),
    );
    if (isMatch) {
      matchCount++;
      if (tWord.length >= 6) hasHighValueWord = true;
    }
  }

  const coverage = matchCount / targetTokens.length;
  const isReliable = coverage >= 0.75 && (matchCount >= 2 || hasHighValueWord);
  if (!isReliable) return { coverage: 0, matchCount: 0, targetLen: 0 };

  return { coverage, matchCount, targetLen: targetTokens.length };
}

/** Coverage of target tokens present in the prompt. 0 if below the reliability floor. */
export function calculateCoverage(promptTokens, targetString) {
  return scoreTarget(promptTokens, targetString).coverage;
}

function isBetter(a, b) {
  if (a.coverage !== b.coverage) return a.coverage > b.coverage;
  if (a.matchCount !== b.matchCount) return a.matchCount > b.matchCount;
  return a.targetLen > b.targetLen;
}

function scoreProcedure(promptTokens, node) {
  let best = scoreTarget(promptTokens, node.trigger || "");
  if (Array.isArray(node.aliases)) {
    for (const alias of node.aliases) {
      const next = scoreTarget(promptTokens, alias);
      if (isBetter(next, best)) best = next;
    }
  }
  return best;
}

function formatSteps(steps, requiresEnv = []) {
  const required =
    requiresEnv.length > 0 ? `Requires environment: ${requiresEnv.join(", ")}\n\n` : "";
  return required + steps.map((s) => `- ${s.t}: ${s.target}`).join("\n");
}

/**
 * Best-scoring root procedure for this prompt, or null.
 * Returns { node, text } ready to inject.
 */
export function recall(prompt, procs) {
  if (!prompt) return null;

  const promptTokens = tokenize(prompt);
  let best = null;
  let bestScore = { coverage: 0, matchCount: 0, targetLen: 0 };

  for (const node of procs) {
    if (node.enabled === false || node.parent_id) continue;
    const score = scoreProcedure(promptTokens, node);
    if (isBetter(score, bestScore)) {
      bestScore = score;
      best = node;
    }
  }

  if (!best) return null;

  let text = formatSteps(best.steps, best.requires_env);
  const alt = procs.find((e) => e.parent_id === best.id && e.type === "alt" && e.enabled !== false);
  if (alt) text += "\n\nAlternative path that worked:\n" + formatSteps(alt.steps, alt.requires_env);

  return {
    node: best,
    text: `Reflex memory found a procedure for this task:\n\n${text}\n\nFollow these steps instead of figuring it out from scratch.`,
  };
}
