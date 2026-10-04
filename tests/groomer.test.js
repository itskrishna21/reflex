import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GROOM_MAX_ATTEMPTS, runGroomer } from "../lib/groomer.js";
import { PROVIDERS } from "../lib/providers.js";
import {
  GROOM_LOCK_STALE_MS,
  appendPending,
  claimPendingBatch,
  paths,
  tryAcquireGroomerLock,
  writeJsonlAtomic,
} from "../lib/store.js";

let DIR;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-groomer-"));
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

function seedPending(nodes) {
  for (const n of nodes) appendPending(DIR, n);
}

function readNodes(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

describe("groomer", () => {
  it("does not write a malformed model response into worker.log", async () => {
    seedPending([{ id: "a", trigger: "deploy", steps: [], status: "pending_review" }]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      "not json; accidentally echoed secret sk-live-DO-NOT-LOG",
    );

    await runGroomer(DIR);

    const log = fs.readFileSync(path.join(DIR, "worker.log"), "utf8");
    expect(log).toContain("Failed to parse LLM JSON response");
    expect(log).not.toContain("DO-NOT-LOG");
  });

  it("preserves hot-path appends that land after pending is claimed", async () => {
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review" }]);
    expect(claimPendingBatch(DIR)).toBe(paths(DIR).processingFile);

    appendPending(DIR, { id: "hot", trigger: "hot", steps: [], status: "pending_review" });
    expect(readNodes(paths(DIR).pendingFile).map((n) => n.id)).toEqual(["hot"]);

    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "a", action: "KEEP", aliases: ["x"] }]),
    );

    await runGroomer(DIR);

    expect(readNodes(paths(DIR).proceduresFile).map((n) => n.id)).toEqual(["a"]);
    expect(readNodes(paths(DIR).pendingFile).map((n) => n.id)).toEqual(["hot"]);
    expect(fs.existsSync(paths(DIR).processingFile)).toBe(false);
  });

  it("drains a second pending batch that arrived during the LLM call", async () => {
    seedPending([
      { id: "a", trigger: "one", steps: [], status: "pending_review" },
      { id: "b", trigger: "two", steps: [], status: "pending_review" },
    ]);

    vi.spyOn(PROVIDERS.openai, "complete").mockImplementation(async (_k, _m, prompt) => {
      if (prompt.includes('"id": "hot"') || prompt.includes('"id":"hot"')) {
        return JSON.stringify([{ id: "hot", action: "KEEP", aliases: ["hot"] }]);
      }
      appendPending(DIR, {
        id: "hot",
        trigger: "hot path",
        steps: [{ t: "Bash", target: "npm test" }],
        status: "pending_review",
      });
      return JSON.stringify([
        { id: "a", action: "KEEP", aliases: ["first"] },
        { id: "b", action: "KEEP", aliases: ["second"] },
      ]);
    });

    const result = await runGroomer(DIR);
    expect(result.batches).toBe(2);
    expect(readNodes(paths(DIR).proceduresFile).map((n) => n.id).sort()).toEqual(["a", "b", "hot"]);
    expect(fs.existsSync(paths(DIR).pendingFile)).toBe(false);
  });

  it("re-queues rows the model gave no verdict on, then drops them after the cap", async () => {
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review" }]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue("[]");

    for (let i = 1; i < GROOM_MAX_ATTEMPTS; i++) {
      await runGroomer(DIR);
      expect(readNodes(paths(DIR).pendingFile)).toEqual([
        expect.objectContaining({ id: "a", groom_attempts: i }),
      ]);
    }

    await runGroomer(DIR);
    expect(fs.existsSync(paths(DIR).pendingFile)).toBe(false);
    expect(readNodes(paths(DIR).proceduresFile)).toEqual([]);
  });

  it("strips groom_attempts when a retried row is finally kept", async () => {
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review", groom_attempts: 1 }]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "a", action: "KEEP", aliases: ["x"] }]),
    );

    await runGroomer(DIR);
    const [node] = readNodes(paths(DIR).proceduresFile);
    expect(node.groom_attempts).toBeUndefined();
    expect(node.status).toBeUndefined();
  });

  it("is single-flight: a second groomer exits while the lock is held", async () => {
    expect(tryAcquireGroomerLock(DIR)).toBe(true);
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review" }]);
    const spy = vi.spyOn(PROVIDERS.openai, "complete");

    const result = await runGroomer(DIR);
    expect(result).toEqual({ ran: false, reason: "locked" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("steals a stale lock", async () => {
    const lock = paths(DIR).groomerLockFile;
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: 999999, startedAt: Date.now() - GROOM_LOCK_STALE_MS - 1 }) + "\n",
    );
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review" }]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "a", action: "KEEP", aliases: ["x"] }]),
    );

    const result = await runGroomer(DIR);
    expect(result.ran).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("migrates legacy pending_review rows out of procedures.jsonl", async () => {
    writeJsonlAtomic(paths(DIR).proceduresFile, [
      { id: "stable", trigger: "ok", steps: [], enabled: true },
      { id: "legacy", trigger: "old", steps: [], status: "pending_review" },
    ]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "legacy", action: "KEEP", aliases: ["legacy"] }]),
    );

    await runGroomer(DIR);

    const stable = readNodes(paths(DIR).proceduresFile);
    expect(stable.map((n) => n.id).sort()).toEqual(["legacy", "stable"]);
    expect(stable.find((n) => n.id === "legacy").status).toBeUndefined();
  });
});
