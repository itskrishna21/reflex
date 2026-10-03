# Reflex

Procedural memory for coding agents.

## Install

```bash
npx agent-procedures init
```

Creates a project-scoped store:

```
.reflex/
  config.json        # settings (not memory)
  procedures.jsonl   # remembered procedures
  runs.jsonl         # optional run outcomes
```

`.reflex/` is added to `.gitignore` by default.

npm install alone does nothing — you need `init` to seed the project.
