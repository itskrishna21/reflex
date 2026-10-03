import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import {
  PROVIDERS,
  PROVIDER_NAMES,
  credentialsFile,
  readCredentials,
  reflexHome,
  resolveCredentials,
} from "./providers.js";

export const USAGE = `Usage:
  npx agent-procedures auth login [--provider <name>] [--model <id>] [--key-stdin]
  npx agent-procedures auth status

Providers: ${PROVIDER_NAMES.join(", ")}

Interactive by default. For scripts/CI, pipe the key on stdin:
  echo "$OPENAI_API_KEY" | npx agent-procedures auth login --provider openai --key-stdin

The groomer also reads ${PROVIDER_NAMES.map((p) => PROVIDERS[p].envVar).join(" / ")}
directly, so \`auth login\` is optional if one of those is already set.`;

function parseArgs(args) {
  const out = { provider: null, model: null, keyStdin: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider" && args[i + 1]) out.provider = args[++i];
    else if (a === "--model" && args[i + 1]) out.model = args[++i];
    else if (a === "--key-stdin") out.keyStdin = true;
    else throw new Error(`Unknown argument: ${a}\n\n${USAGE}`);
  }
  return out;
}

function ask(question, io) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Readline with a muted output stream: line editing still works, nothing is echoed.
function askHidden(question, io) {
  return new Promise((resolve) => {
    io.stdout.write(question);
    const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    const rl = readline.createInterface({ input: io.stdin, output: muted, terminal: true });
    rl.question("", (answer) => {
      rl.close();
      io.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data.trim()));
    stream.on("error", reject);
  });
}

async function chooseProvider(io) {
  const menu = PROVIDER_NAMES.map((p, i) => `  [${i + 1}] ${PROVIDERS[p].label}`).join("\n");
  const answer = await ask(`Provider:\n${menu}\n> `, io);
  const byIndex = PROVIDER_NAMES[Number(answer) - 1];
  const byName = PROVIDER_NAMES.find((p) => p === answer.toLowerCase());
  const provider = byIndex || byName;
  if (!provider) throw new Error(`Unknown provider "${answer}". Choose one of: ${PROVIDER_NAMES.join(", ")}`);
  return provider;
}

function saveCredentials(provider, apiKey, model) {
  const dir = reflexHome();
  const file = credentialsFile();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let creds = { version: 1, providers: {} };
  try {
    creds = { ...creds, ...(readCredentials() || {}) };
  } catch (e) {
    // corrupt file; start fresh
  }
  creds.providers = creds.providers || {};
  creds.providers[provider] = { apiKey, model };
  creds.defaultProvider = provider;

  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600); // mode above only applies on create
  return file;
}

export async function login(args, io = { stdin: process.stdin, stdout: process.stdout }) {
  const opts = parseArgs(args);
  const interactive = Boolean(io.stdin.isTTY) && !opts.keyStdin;

  let provider = opts.provider;
  if (provider && !PROVIDERS[provider]) {
    throw new Error(`Unsupported provider "${provider}". Choose one of: ${PROVIDER_NAMES.join(", ")}`);
  }
  if (!provider) {
    if (!interactive) throw new Error(`--provider is required when not running interactively.\n\n${USAGE}`);
    provider = await chooseProvider(io);
  }
  const def = PROVIDERS[provider];

  let apiKey;
  if (opts.keyStdin) {
    apiKey = await readAll(io.stdin);
  } else if (interactive) {
    apiKey = await askHidden(`${def.label} API key (get one at ${def.keysUrl}): `, io);
  } else {
    throw new Error(`No key given. Use --key-stdin when not running interactively.\n\n${USAGE}`);
  }
  if (!apiKey) throw new Error("No key given.");

  if (!apiKey.startsWith(def.keyPrefix)) {
    io.stdout.write(`Warning: ${def.label} keys usually start with "${def.keyPrefix}". Checking anyway.\n`);
  }

  const model = opts.model || def.defaultModel;

  io.stdout.write(`Checking key with ${def.label}... `);
  try {
    await def.verify(apiKey);
  } catch (e) {
    io.stdout.write("failed\n");
    throw new Error(`${def.label} rejected the key: ${e.message}`);
  }
  io.stdout.write("ok\n");

  const file = saveCredentials(provider, apiKey, model);
  io.stdout.write(`Saved to ${file} (readable only by you)\n`);
  io.stdout.write(`Provider: ${def.label}\nModel: ${model}\n`);
}

function maskKey(key) {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function status(io = { stdout: process.stdout }, cwd = process.cwd()) {
  const resolved = resolveCredentials();
  if (!resolved) {
    io.stdout.write(
      `Not configured. Run \`npx agent-procedures auth login\` or set one of: ${PROVIDER_NAMES.map((p) => PROVIDERS[p].envVar).join(", ")}\n`,
    );
  } else {
    const def = PROVIDERS[resolved.provider];
    const from = resolved.source === "env" ? `env ${def.envVar}` : credentialsFile();
    io.stdout.write(`Provider: ${def.label}\nModel: ${resolved.model}\nKey: ${maskKey(resolved.apiKey)} (from ${from})\n`);
  }

  const log = path.join(cwd, ".reflex", "worker.log");
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (last) io.stdout.write(`Last groomer error: ${last}\n`);
  }
}
