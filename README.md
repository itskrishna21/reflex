# Reflex

Your coding agent figures things out. Then it forgets and figures them out again.

Reflex watches what the agent actually did when something worked, saves that path, and hands it back the next time you ask for something similar. It does not store facts or preferences. Your docs already cover that. It stores **how**.

The npm package is `agent-procedures`. The product is Reflex.

## Install

In the repo where you want memory:

```bash
npx agent-procedures init
# or, for Cursor:
npx agent-procedures init --harness cursor
```

`init` is required. Installing the package alone does nothing. It sets up a small folder in the repo and wires your agent so Reflex runs in the background.

Supported today:

- **Claude Code** — default
- **Cursor** — `--harness cursor`

You can use both in one repo if you want. If Cursor also runs Claude’s hooks and you see double work, turn off third-party Claude hooks in Cursor and keep each tool on its own wiring.

## Daily use

There is nothing to run. Keep talking to your agent.

When a task succeeds, Reflex quietly remembers the steps. When you ask for something similar later — including short follow-ups like “do the same for the other page” — it can feed those steps back so the agent does not start from zero.

After a few new memories pile up, a background reviewer cleans them up: drops junk, shortens triggers, adds other ways you might ask. You do not start that yourself.

## See what you got back

```bash
npx agent-procedures ui --open
```

Opens a local page for **this repo**: how many times Reflex helped this week, which sessions, which memories, and a rough estimate of tokens you did not spend rediscovering the same path. Estimates only — not a bill from the model.

## API key (background cleanup only)

The background reviewer needs a cheap model key. Day-to-day remembering does not.

If `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` is already in your terminal, Reflex uses that. Otherwise:

```bash
npx agent-procedures auth login
npx agent-procedures auth status
```

The key is checked when you save it, stored only on your machine (`~/.reflex/credentials.json`), and readable only by you.

## What to commit

After `init`, commit:

- `.reflex/config.json`
- `.reflex/package.json`
- `.reflex/procedures.jsonl` — the shared memory
- `.reflex/runs.jsonl`
- `.reflex/runtime.js`
- the hook wiring (`.claude/settings.json` and/or `.cursor/hooks.json`)

Everything else under `.reflex/` stays local (scratch, pending review, hit log). Teammates who clone the repo get the same remembered how-tos.

When you upgrade the package, run `init` again. That refreshes `runtime.js`.

## Secrets

Reflex scrubs prompts and commands before saving. Known inline credentials become “needs this env var” instead of storing the value. If it sees a secret it cannot safely rewrite, it skips that turn.

Still: put secrets in the environment or a secret manager, not in the chat.

## License

MIT
