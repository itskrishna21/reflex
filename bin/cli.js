#!/usr/bin/env node

import { init } from "../lib/init.js";

const [command] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  console.log(`agent-procedures — procedural memory for coding agents (Reflex)

Usage:
  npx agent-procedures init [--harness claude|cursor]   Create .reflex/ and wire hooks
  npx agent-procedures ui [--port 7373] [--open]        Hits dashboard for this repo
  npx agent-procedures auth login                Store an API key for the background groomer
  npx agent-procedures auth status               Show which provider/key the groomer will use
`);
  process.exit(command ? 0 : 1);
}

if (command === "init") {
  const args = process.argv.slice(3);
  const i = args.indexOf("--harness");
  const harness = i >= 0 ? args[i + 1] : undefined;
  try {
    const results = init(process.cwd(), { harness });
    console.log("Initialized Reflex in the repository");
    console.log(`  .reflex/config.json       ${results.config}`);
    console.log(`  .reflex/procedures.jsonl  ${results.procedures}`);
    console.log(`  .reflex/runs.jsonl        ${results.runs}`);
    console.log(`  .reflex/runtime.js        ${results.runtime}`);
    console.log(`  .gitignore                ${results.gitignore}`);
    console.log(`  hooks (${harness || "claude"})            ${results.hooks}`);
    process.exit(0);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

if (command === "ui") {
  const args = process.argv.slice(3);
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : 7373;
  const open = args.includes("--open");
  try {
    const { startUi } = await import("../lib/ui.js");
    const { url } = await startUi({ cwd: process.cwd(), port, open });
    console.log(`Reflex UI ${url}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
} else if (command === "auth") {
  const { login, status, USAGE } = await import("../lib/auth.js");
  const [sub, ...rest] = process.argv.slice(3);
  try {
    if (sub === "login") await login(rest);
    else if (sub === "status") status();
    else {
      console.error(USAGE);
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

console.error(`Unknown command: ${command}`);
console.error("Run `npx agent-procedures --help` for usage.");
process.exit(1);
