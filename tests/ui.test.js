import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendHit } from "../lib/store.js";
import { buildUiData } from "../lib/ui.js";

let DIR;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-ui-"));
});
afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("ui data", () => {
  it("summarizes this week's hits newest first", () => {
    const now = new Date("2026-10-06T18:00:00Z");
    appendHit(DIR, {
      ts: "2026-10-06T13:32:00.000Z",
      session: "conv_7f3a91xx",
      procedure: "a",
      trigger: "add receipt upload",
      saved_tokens: 6200,
      steps: [{ t: "Write", target: "expense route" }],
    });
    appendHit(DIR, {
      ts: "2026-09-20T13:32:00.000Z",
      session: "old",
      trigger: "stale",
      saved_tokens: 9000,
      steps: [],
    });
    appendHit(DIR, {
      ts: "2026-10-05T10:41:00.000Z",
      session: "conv_2aa0",
      trigger: "paywall empty copy",
      saved_tokens: 900,
      steps: [{ t: "Edit", target: "paywall helper line" }],
    });

    const data = buildUiData(DIR, { repo: "kite", now });
    expect(data.repo).toBe("kite");
    expect(data.hitCount).toBe(2);
    expect(data.savedLabel).toBe("7.1k");
    expect(data.hits.map((h) => h.trigger)).toEqual(["add receipt upload", "paywall empty copy"]);
    expect(data.hits[0].session).toBe("conv_7f3");
    expect(data.hits[0].saved).toBe("6.2k");
    expect(data.hits[0].steps).toEqual(["Write: expense route"]);
    expect(data.hits[1].time).toMatch(/Yesterday/);
  });

  it("empty week is zeros", () => {
    const data = buildUiData(DIR, { repo: "kite", now: new Date("2026-10-06T18:00:00Z") });
    expect(data.hitCount).toBe(0);
    expect(data.savedLabel).toBe("0");
    expect(data.hits).toEqual([]);
  });
});
