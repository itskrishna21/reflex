#!/usr/bin/env node

import { init } from "../lib/init.js";

const [command] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  console.log(`agent-procedures — procedural memory for coding agents (Reflex)

Usage:
  npx agent-procedures init    Create .reflex/ in the current project
`);
  process.exit(command ? 0 : 1);
}

if (command === "init") {
  const results = init(process.cwd());
  console.log("Initialized Reflex in .reflex/");
  console.log(`  config.json       ${results.config}`);
  console.log(`  procedures.jsonl  ${results.procedures}`);
  console.log(`  runs.jsonl        ${results.runs}`);
  console.log(`  .gitignore        ${results.gitignore}`);
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error("Run `npx agent-procedures --help` for usage.");
process.exit(1);
