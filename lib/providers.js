import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Shared by `auth` (CLI) and the groomer (background hook). Keep dependency-free.

export function reflexHome() {
  return process.env.REFLEX_HOME || path.join(os.homedir(), ".reflex");
}

export function credentialsFile() {
  return path.join(reflexHome(), "credentials.json");
}

const SYSTEM_PROMPT =
  "You are the Reflex graph groomer. Your job is to review execution edges from coding agents, drop bad ones, and add semantic aliases.";

async function expectOk(res, label) {
  if (res.ok) return;
  let detail = await res.text().catch(() => "");
  try {
    // All three providers return { error: { message } } on failure.
    detail = JSON.parse(detail).error?.message || detail;
  } catch (e) {}
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 200);
  throw new Error(`${label} API error: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`);
}

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5",
    keyPrefix: "sk-ant-",
    keysUrl: "https://console.anthropic.com/settings/keys",
    async verify(apiKey) {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      await expectOk(res, "Anthropic");
    },
    async complete(apiKey, model, prompt) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      await expectOk(res, "Anthropic");
      const data = await res.json();
      return data.content[0].text;
    },
  },

  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-6-luna",
    keyPrefix: "sk-",
    keysUrl: "https://platform.openai.com/api-keys",
    async verify(apiKey) {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      await expectOk(res, "OpenAI");
    },
    async complete(apiKey, model, prompt) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          // Newer OpenAI models (incl. gpt-6-luna) reject max_tokens.
          max_completion_tokens: 1024,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
      });
      await expectOk(res, "OpenAI");
      const data = await res.json();
      return data.choices[0].message.content;
    },
  },

  gemini: {
    label: "Gemini",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash-lite",
    keyPrefix: "AIza",
    keysUrl: "https://aistudio.google.com/apikey",
    async verify(apiKey) {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        { headers: { "x-goog-api-key": apiKey } },
      );
      await expectOk(res, "Gemini");
    },
    async complete(apiKey, model, prompt) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1024 },
          }),
        },
      );
      await expectOk(res, "Gemini");
      const data = await res.json();
      return data.candidates[0].content.parts[0].text;
    },
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export function readCredentials() {
  const file = credentialsFile();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Resolve which provider/key/model the groomer should use.
 *
 * Provider: credentials.json's defaultProvider if present, else the first
 * provider with an env var set.
 * Key: the provider's env var wins over the stored key.
 * Model: stored model, else the provider default.
 *
 * Returns null if nothing usable is found.
 */
export function resolveCredentials(env = process.env) {
  let stored = null;
  try {
    stored = readCredentials();
  } catch (e) {
    throw new Error(`Failed to parse ${credentialsFile()}: ${e.message}`);
  }

  let provider = stored?.defaultProvider;
  if (!provider) {
    provider = PROVIDER_NAMES.find((p) => env[PROVIDERS[p].envVar]);
  }
  if (!provider || !PROVIDERS[provider]) return null;

  const def = PROVIDERS[provider];
  const entry = stored?.providers?.[provider] || {};

  const envKey = env[def.envVar];
  const apiKey = envKey || entry.apiKey;
  if (!apiKey) return null;

  return {
    provider,
    apiKey,
    model: entry.model || def.defaultModel,
    source: envKey ? "env" : "file",
  };
}
