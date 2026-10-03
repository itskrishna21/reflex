#!/usr/bin/env node

import { init } from "../lib/init.js";

const [command] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  console.log(`agent-procedures — procedural memory for coding agents (Reflex)

Usage:
  npx agent-procedures init          Create .reflex/ and wire hooks
  npx agent-procedures auth login    Store an API key for the background groomer
  npx agent-procedures auth status   Show which provider/key the groomer will use
`);
  process.exit(command ? 0 : 1);
}

if (command === "init") {
  const results = init(process.cwd());
  console.log("Initialized Reflex in the repository");
  console.log(`  .reflex/config.json       ${results.config}`);
  console.log(`  .reflex/procedures.jsonl  ${results.procedures}`);
  console.log(`  .reflex/runs.jsonl        ${results.runs}`);
  console.log(`  .gitignore                ${results.gitignore}`);
  console.log(`  .claude/hooks/            ${results.hooks}`);
  process.exit(0);
}

if (command === "auth") {
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
