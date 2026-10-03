import claude from "./claude.js";

// To add a harness: write lib/harnesses/<id>.js with the same shape as claude.js
// (id, hookFile, register, normalize, render) and list it here.
export const HARNESSES = { claude };

export const DEFAULT_HARNESS = "claude";

export function getHarness(id = DEFAULT_HARNESS) {
  const h = HARNESSES[id];
  if (!h) {
    throw new Error(`Unknown harness "${id}". Available: ${Object.keys(HARNESSES).join(", ")}`);
  }
  return h;
}
