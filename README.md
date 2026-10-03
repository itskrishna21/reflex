# Reflex

Procedural memory for coding agents.

Agents are good at figuring things out and bad at remembering how they did it last time. Reflex watches the tools Claude Code actually runs, keeps the paths that worked, and hands them back the next time a similar prompt shows up. Facts stay in your docs. This stores **how**.

Package name is `agent-procedures`. Product name is Reflex.

## Status

Early. Claude Code only for now. Other harnesses (Cursor, etc.) are the same brain with different wiring — not built yet.

## Install

In the repo you want Reflex in:

```bash
npx agent-procedures init
```

That creates the store, wires Claude Code hooks, and leaves a runner under `.claude/hooks/`. `npm install` alone does nothing — you need `init`.

After that you just use Claude. Capture, recall, write. No extra commands for daily use.

## What's on disk

```
.reflex/
  config.json        # knobs, not memory
  procedures.jsonl   # remembered procedures (commit this)
  runs.jsonl         # optional run outcomes
  traces/            # scratch for the current turn (gitignored)
```

Init adds `.reflex/traces/` to `.gitignore`. Commit the rest of `.reflex/` and the `.claude/` hook wiring so a clone comes up ready.

## API key (for the groomer)

Hot path is disk only. No LLM on every prompt.

A background groomer reviews new procedures later — drop bad ones, add aliases so recall matches paraphrases. It needs a cheap model key. Env vars win if set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). Otherwise:

```bash
npx agent-procedures auth login    # pick provider, paste key (checked before save)
npx agent-procedures auth status   # what's active, last groomer error
```

Keys land in `~/.reflex/credentials.json`, mode 600. That file is personal. Procedures stay in the repo.

## Commands

```bash
npx agent-procedures init
npx agent-procedures auth login
npx agent-procedures auth status
```

## License

MIT
