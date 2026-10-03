import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { init } from '../lib/init.js';

let DIR;
const settings = () => JSON.parse(fs.readFileSync(path.join(DIR, '.claude', 'settings.json'), 'utf8'));

beforeEach(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-init-')); });
afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

describe('init', () => {
  it('wires hooks in the shape Claude Code reads', () => {
    init(DIR);
    const s = settings();
    for (const ev of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
      expect(s.hooks[ev]).toEqual([
        { hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/reflex.mjs" ${ev}` }] },
      ]);
    }
  });

  it('is idempotent and preserves unrelated hooks', () => {
    fs.mkdirSync(path.join(DIR, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(DIR, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    }));

    init(DIR);
    init(DIR);

    const s = settings();
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('say done');
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('installs the engine under .reflex/engine and a thin shim under the harness dir', () => {
    init(DIR);
    for (const f of ['main.js', 'engine.js', 'store.js', 'groomer.js', 'providers.js', 'harnesses/index.js', 'harnesses/claude.js']) {
      expect(fs.existsSync(path.join(DIR, '.reflex', 'engine', f))).toBe(true);
    }
    const shim = fs.readFileSync(path.join(DIR, '.claude', 'hooks', 'reflex.mjs'), 'utf8');
    expect(shim).toContain('from "../../.reflex/engine/main.js"');
    expect(shim).toContain('run("claude")');
    expect(JSON.parse(fs.readFileSync(path.join(DIR, '.reflex', 'config.json'), 'utf8')).harness).toBe('claude');
  });

  it('rejects an unknown harness', () => {
    expect(() => init(DIR, { harness: 'nope' })).toThrow(/Unknown harness "nope"/);
  });

  it('shim runs end to end the way Claude Code would call it', () => {
    init(DIR);
    const hook = (event, payload) =>
      execSync(`node .claude/hooks/reflex.mjs ${event}`, { cwd: DIR, input: JSON.stringify(payload), encoding: 'utf8' });
    const ids = { session_id: 's1', prompt_id: 'p1' };

    expect(hook('UserPromptSubmit', { ...ids, hook_event_name: 'UserPromptSubmit', prompt: 'lint and fix' }).trim()).toBe('{}');
    hook('PostToolUse', { ...ids, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm run lint -- --fix' } });
    hook('Stop', { ...ids, hook_event_name: 'Stop', stop_hook_active: false });

    const [node] = fs.readFileSync(path.join(DIR, '.reflex', 'procedures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(node.steps).toEqual([{ t: 'Bash', target: 'npm run lint -- --fix' }]);

    const out = JSON.parse(hook('UserPromptSubmit', { session_id: 's2', prompt_id: 'p2', hook_event_name: 'UserPromptSubmit', prompt: 'please lint and fix it' }));
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('npm run lint -- --fix');
  });
});
