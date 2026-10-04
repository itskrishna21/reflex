import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGroomer } from "../lib/groomer.js";
import { PROVIDERS } from "../lib/providers.js";

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

describe("groomer", () => {
  it("does not write a malformed model response into worker.log", async () => {
    const procedures = path.join(DIR, "procedures.jsonl");
    fs.writeFileSync(
      procedures,
      `${JSON.stringify({ id: "a", trigger: "deploy", steps: [], status: "pending_review" })}\n`,
    );
    vi.spyOn(PROVIDERS.openai, "complete").mockResolvedValue(
      "not json; accidentally echoed secret sk-live-DO-NOT-LOG",
    );

    await runGroomer(procedures);

    const log = fs.readFileSync(path.join(DIR, "worker.log"), "utf8");
    expect(log).toContain("Failed to parse LLM JSON response");
    expect(log).not.toContain("DO-NOT-LOG");
  });
});
