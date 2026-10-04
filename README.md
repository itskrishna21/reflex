# Reflex

Procedural memory for coding agents.

Coding agents are pretty good at figuring things out. They're bad at remembering how they did it last time, so they just figure it out again. Every time.

Reflex watches the tools your agent actually runs, keeps the paths that worked, and hands them back the next time you ask for something similar. It doesn't store facts, your docs already do that. It stores how.

The npm package is `agent-procedures`. The product is Reflex.

## How it works (hot path vs cold path)

The **hot path** runs every time you prompt the agent or the agent runs a tool. It has to be fast, so it doesn't call an LLM. It's just disk I/O. When you ask for something, Reflex checks its memory for a match and injects the steps into the agent's context. When the agent uses tools, Reflex traces what happens. If the agent gets the job done without leaving broken steps behind, Reflex saves that trace as a new procedure.

The **cold path** is a background groomer. Once 5 new procedures pile up, it kicks off a background process that asks a cheap LLM to review them. It drops the risky ones and adds aliases (like synonyms) to the good ones so they match more easily next time. 

You don't run either of these manually. You just use your agent.

## Status & Harnesses

Early. Reflex is built to plug into different agent platforms (harnesses). Right now, **Claude Code is the only one built** and is the default.

I set the engine up so Cursor and others can plug in later, but the adapters for those don't exist yet.

## Install

Run this in the repo you want Reflex in:

```bash
npx agent-procedures init
```

By default this installs the Claude Code harness. If you were using a different one later, you'd run `npx agent-procedures init --harness cursor`. 

Installing the package on its own won't do anything. You need `init`. It creates the folders, copies the runtime in, and adds a hook so your agent knows to call it.

## API key (for the background groomer)

Because the groomer uses an LLM to review procedures, it needs a cheap model key. 

If you already have `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` exported in your terminal, it just uses that. Otherwise:

```bash
npx agent-procedures auth login    # pick a provider, paste your key
npx agent-procedures auth status   # check what it's using and the last groomer error
```

The key gets checked before it's saved, so a typo fails right away instead of a week later in a log file. It gets stored in `~/.reflex/credentials.json` on your machine and only you can read it. 

## What ends up in your repo

```
.reflex/
  config.json        # settings, not memory
  procedures.jsonl   # stable memory (commit this)
  runs.jsonl         # optional run outcomes
  runtime.js         # the engine, one bundled file — do not edit
  pending.jsonl      # ingest buffer (local, gitignored)
  processing.jsonl   # batch the groomer is reviewing right now (local)
  groomer.lock       # single-flight guard for the groomer (local)
  traces/            # scratch for the current turn
```

The hot path only appends to `pending.jsonl`. A background groomer renames that buffer to `processing.jsonl`, reviews it, and merges keepers into `procedures.jsonl`. Recall reads all three, so memory works before grooming finishes.

Init ignores everything under `.reflex/` except `config.json`, `procedures.jsonl`, `runs.jsonl`, and `runtime.js`. **Commit those four files**, plus `.claude/settings.json` (the hook wiring), so anyone who clones the repo gets the same memory. If you upgrade the package, run `init` again. That overwrites `runtime.js`.

## Secrets

Reflex sanitizes prompts and tool targets before writing traces. Inline credentials it can identify are promoted to environment requirements, so a stored procedure keeps `npm run migrate` and records that it needs `DATABASE_URL` instead of storing the URL value. Recall tells the agent which variables must already be set.

Reflex also checks for common provider credentials using signatures ported from Gitleaks. If it detects a secret that it cannot safely parameterize, it drops that turn instead of writing a procedure or sending it to the groomer.

Secret detection is defense in depth, not a guarantee. Do not put credentials directly in prompts or command lines; use environment variables or a secret manager.

## Adding a harness

If you want to build an adapter for something other than Claude Code:

Only three things change between harnesses: where hooks get registered, what the event payload looks like, and how context gets passed back to the agent. The rest of the engine doesn't care who called it.

Adding one is a single file in `lib/harnesses/` plus one line in `lib/harnesses/index.js`. `claude.js` is the reference.

## License

MIT
