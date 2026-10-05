import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GROOM_MAX_ATTEMPTS, runGroomer } from "../lib/groomer.js";
import { PROVIDERS } from "../lib/providers.js";
import {
  GROOM_LOCK_STALE_MS,
  SESSION_STALE_MS,
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

  it("retries a stuck processing batch after an API failure", async () => {
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review" }]);
    vi.spyOn(PROVIDERS.openai, "complete")
      .mockRejectedValueOnce(new Error("OpenAI API error: 400 - use max_completion_tokens"))
      .mockResolvedValueOnce(JSON.stringify([{ id: "a", action: "KEEP", trigger: "groomed", aliases: ["x"] }]));

    await runGroomer(DIR);
    expect(fs.existsSync(paths(DIR).processingFile)).toBe(true);
    expect(readNodes(paths(DIR).proceduresFile)).toEqual([]);

    await runGroomer(DIR);
    expect(readNodes(paths(DIR).proceduresFile).map((n) => n.id)).toEqual(["a"]);
    expect(fs.existsSync(paths(DIR).processingFile)).toBe(false);
  });

  it("preserves hot-path appends that land after pending is claimed", async () => {
    seedPending([{ id: "a", trigger: "one", steps: [], status: "pending_review" }]);
    expect(claimPendingBatch(DIR)).toBe(paths(DIR).processingFile);

    appendPending(DIR, { id: "hot", trigger: "hot", steps: [], status: "pending_review" });
    expect(readNodes(paths(DIR).pendingFile).map((n) => n.id)).toEqual(["hot"]);

    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "a", action: "KEEP", trigger: "groomed", aliases: ["x"] }]),
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
        return JSON.stringify([{ id: "hot", action: "KEEP", trigger: "groomed", aliases: ["hot"] }]);
      }
      appendPending(DIR, {
        id: "hot",
        trigger: "hot path",
        steps: [{ t: "Bash", target: "npm test" }],
        status: "pending_review",
      });
      return JSON.stringify([
        { id: "a", action: "KEEP", trigger: "groomed", aliases: ["first"] },
        { id: "b", action: "KEEP", trigger: "groomed", aliases: ["second"] },
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
      JSON.stringify([{ id: "a", action: "KEEP", trigger: "groomed", aliases: ["x"] }]),
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
      JSON.stringify([{ id: "a", action: "KEEP", trigger: "groomed", aliases: ["x"] }]),
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
      JSON.stringify([{ id: "legacy", action: "KEEP", trigger: "groomed", aliases: ["legacy"] }]),
    );

    await runGroomer(DIR);

    const stable = readNodes(paths(DIR).proceduresFile);
    expect(stable.map((n) => n.id).sort()).toEqual(["legacy", "stable"]);
    expect(stable.find((n) => n.id === "legacy").status).toBeUndefined();
  });

  it("sends the transcript and replaces trigger, aliases and steps; transcript never reaches procedures", async () => {
    const transcript = [
      { role: "user", text: "build auth" },
      { role: "agent", text: "Option A: JWT. Option B: OAuth." },
      { role: "user", text: "pick option A" },
    ];
    seedPending([
      {
        id: "a",
        title: "pick option A",
        trigger: "pick option A",
        transcript,
        steps: [{ t: "Write", target: "/Users/me/app/src/auth.js" }],
        status: "pending_review",
      },
    ]);
    const spy = vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([
        {
          id: "a",
          action: "KEEP",
          trigger: "Add JWT auth",
          aliases: ["set up jwt"],
          steps: [{ t: "Write", target: "the auth module" }],
        },
      ]),
    );

    await runGroomer(DIR);

    expect(spy.mock.calls[0][2]).toContain("Option A: JWT. Option B: OAuth.");
    const [node] = readNodes(paths(DIR).proceduresFile);
    expect(node).toMatchObject({
      id: "a",
      title: "Add JWT auth",
      trigger: "Add JWT auth",
      aliases: ["set up jwt"],
      steps: [{ t: "Write", target: "the auth module" }],
    });
    expect(node.transcript).toBeUndefined();
    expect(fs.readFileSync(paths(DIR).proceduresFile, "utf8")).not.toContain("/Users/me");
  });

  it("re-queues a kept root that came back without a trigger", async () => {
    seedPending([{ id: "a", trigger: "pick option A", steps: [], status: "pending_review" }]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "a", action: "KEEP", aliases: ["x"] }]),
    );

    await runGroomer(DIR);

    expect(readNodes(paths(DIR).proceduresFile)).toEqual([]);
    expect(readNodes(paths(DIR).pendingFile)).toEqual([
      expect.objectContaining({ id: "a", trigger: "pick option A", groom_attempts: 1 }),
    ]);
  });

  it("keeps the recorded steps when the model's steps are malformed", async () => {
    seedPending([{ id: "a", trigger: "x", steps: [{ t: "Bash", target: "npm test" }], status: "pending_review" }]);
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      JSON.stringify([{ id: "a", action: "KEEP", trigger: "Run tests", steps: [{ t: "Bash" }] }]),
    );

    await runGroomer(DIR);
    expect(readNodes(paths(DIR).proceduresFile)[0].steps).toEqual([{ t: "Bash", target: "npm test" }]);
  });

  it("deletes session scratchpads older than a week", async () => {
    const dir = paths(DIR).sessionsDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "fresh.jsonl"), "{}\n");
    const old = (Date.now() - SESSION_STALE_MS - 1000) / 1000;
    fs.utimesSync(path.join(dir, "old.jsonl"), old, old);

    await runGroomer(DIR);
    expect(fs.readdirSync(dir)).toEqual(["fresh.jsonl"]);
  });
});
