# Reflex dogfood notes

Living list of what’s broken / rough while testing. Not a roadmap.

## Fixed

- **ESM runtime in CommonJS hosts** — `.mjs` shim couldn’t `import { run }` from `.reflex/runtime.js` when the app was `"type":"commonjs"`. Fixed in **0.4.2** via `.reflex/package.json` `{ "type": "module" }`.

## Open

1. **Cursor Grep (and maybe others) → empty `target`**  
   Pending procedures store `{"t":"Grep","target":""}`. Cursor tool_input shape isn’t mapped in `lib/harnesses/cursor.js` (`pattern` / `path` / etc.). Write/Shell paths look fine.

2. **`config.json` harness field stays stale on re-init**  
   `writeIfMissing` never updates `harness` when you switch `--harness cursor` after a Claude init. Ripple still showed `"harness":"claude"` while Cursor hooks were live. Cosmetic for the engine (shim hardcodes id), confusing for humans.

3. **Claude hooks still fire under Cursor (third-party)**  
   Every Cursor event also runs `node "$CLAUDE_PROJECT_DIR/.claude/hooks/reflex.mjs" …` → exit **127** (`node` not on PATH). Noise in Hooks log; Cursor harness is the one that works. Dual-agent is fine; double-run under Cursor is messy unless third-party Claude hooks are off.

4. **No Claude-style UI recall notice on Cursor**  
   `user_message` + `continue:true` does not show in chat. Mitigated: notice prepended into `additional_context` (0.4.1). Model sees it; no toast.

5. **No backfill**  
   Turns that ran while hooks crashed (e.g. Ripple “add loading…”) are gone. Expected.

6. **Recall miss on long verbatim triggers** (2026-10-04)  
   Learned trigger was the full Agent prompt (~30 tokens). Recall query shared 14/30 tokens → coverage ~0.47 < **0.75** floor → hook returned `{ continue: true }` only, no `additional_context`.  
   Prompt tried: *How did we fix the competitor detail empty signals copy for a baseline snapshot when there’s nothing to compare yet?*  
   Hot path works; matcher is too strict / triggers too long when the goal is a pasted essay.

7. **Groomer OpenAI 400: `max_tokens` unsupported** (2026-10-04) — **fixed in 0.4.3**  
   Was: `max_tokens` rejected by `gpt-6-luna`. Now: `max_completion_tokens`.  
   Stuck `processing.jsonl` is retried on the next `runGroomer` (claim returns existing processing).

8. **Agent bundles multiple file edits into one Goal**  
   Dashboard prompt also wrote ops → one pending line, not two. Speeds threshold poorly.

9. **Groomer DROPPED all 5 dogfood copy tweaks** (2026-10-04)  
   After 0.4.3 retry: `batches: 1`, processing cleared, **`procedures.jsonl` empty**, no new worker error.  
   Model likely DROP’d them as unverified / one-off (prompt asks: did agent verify? reusable?).  
   Tiny UI string edits with no test/log check match DROP. Need a learnable turn that **runs a check** (e.g. `npm test` / lint) or loosen groom criteria for copy-only flows.

## Verified working (Ripple, Cursor, 0.4.2)

- Hook PATH via absolute `node`
- `beforeSubmitPrompt` / `postToolUse` / `stop` exit 0
- Mutating turn → `pending.jsonl` (baseline signals copy, 2026-10-04)
- Read-only turns correctly do **not** learn

## Full pipeline test (Ripple Agent chat)

Goal: `pending.jsonl` → background groomer → `procedures.jsonl` → recall hit.

State now: **1** pending, **0** procedures. Groomer auto-starts at **5** pending. Auth OK (OpenAI in `~/.reflex/credentials.json`).

Use **short** prompts so triggers aren’t novels (helps recall later).

### A. Fill pending to 5 (one Agent turn each; must Edit/Write)

1. [x] baseline signals empty copy → `pending.jsonl` line 1  
2. [x] analysis empty helper → pending #2  
3. [ ] competitors empty helper — **skipped by agent** (already had “Add one to start tracking.”; Read/Grep/Shell only → judge correctly wrote nothing)  
4. [ ] `On dashboard empty state, change the helper line to: “Add a competitor to see threat activity.” File: frontend/src/app/dashboard/page.tsx only.`  
5. [ ] `On ops page heading subtitle, change it to “Queue health and worker status.” File: frontend/src/app/ops/page.tsx only.`  
6. [ ] `In competitors list empty helper, change “Add one to start tracking.” to “Add a competitor to start weekly tracking.” File: frontend/src/app/competitors/page.tsx only.`  
7. [ ] one more if needed to hit 5

After turn 5 Stop: expect `groomer.lock` / `processing.jsonl` briefly, then keepers in `procedures.jsonl`, `worker.log` if LLM fails.

### B. Groomer run (2026-10-04)

- [x] Auto-spawn at 5 pending  
- [x] `pending` claimed → `processing.jsonl` (5)  
- [x] OpenAI `max_tokens` failure logged (#7)  
- [x] Retry after 0.4.3 fix completes a batch  
- [ ] KEEP → `procedures.jsonl` — **blocked by open #9** (all DROP)

### C. After groom (blocked on #9)

- [ ] aliases on kept roots  
- [ ] Recall with short paraphrase → `additional_context`

### D. Already done

- [x] Learn path (mutating → pending)  
- [x] Recall attempt (miss — open #6)  
- [x] Read-only does not learn  
- [x] Threshold → background worker fires
