export const TOKENS_PER_TOOL = 600;

export function countColdTools(lines) {
  return (lines || []).filter((l) => l && l.t && l.t !== "Goal" && l.t !== "Recall").length;
}

export function coldEstTokens(toolCount, stepCount = 0) {
  const n = toolCount > 0 ? toolCount : stepCount;
  return n * TOKENS_PER_TOOL;
}

export function injectTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

export function savedTokens(node, injectText) {
  const cold =
    typeof node?.cold_est_tokens === "number"
      ? node.cold_est_tokens
      : coldEstTokens(node?.cold_tools || 0, (node?.steps || []).length);
  return Math.max(0, cold - injectTokens(injectText));
}

export function formatTokens(n) {
  const x = Math.max(0, Math.round(Number(n) || 0));
  if (x >= 10000) return `${Math.round(x / 1000)}k`;
  if (x >= 1000) {
    const k = x / 1000;
    return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(x);
}
