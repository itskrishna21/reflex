import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../lib/providers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("providers", () => {
  it("OpenAI complete uses max_completion_tokens, not max_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await PROVIDERS.openai.complete("sk-test", "gpt-6-luna", "hello");

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.max_tokens).toBeUndefined();
  });
});
