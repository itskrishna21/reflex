import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { init } from '../lib/init.js';

let DIR;
const settings = () => JSON.parse(fs.readFileSync(path.join(DIR, '.claude', 'settings.json'), 'utf8'));

beforeEach(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-init-')); });
afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

describe('init', () => {
  it('wires hooks in the shape Claude Code reads', () => {
    init(DIR);
    const s = settings();
    expect(s.customHooks).toBeUndefined();
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

  it('ships the groomer next to the hook so the import resolves', () => {
    init(DIR);
    const hooks = path.join(DIR, '.claude', 'hooks');
    for (const f of ['reflex.mjs', 'groomer.js', 'providers.js']) {
      expect(fs.existsSync(path.join(hooks, f))).toBe(true);
    }
    expect(fs.readFileSync(path.join(hooks, 'reflex.mjs'), 'utf8')).not.toContain('require(');
  });
});
