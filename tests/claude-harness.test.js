import { describe, it, expect } from 'vitest';
import claude from '../lib/harnesses/claude.js';

const base = { session_id: 's', prompt_id: 'p', cwd: '/x', permission_mode: 'default' };

describe('claude harness', () => {
  it('normalizes UserPromptSubmit', () => {
    expect(claude.normalize('UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }))
      .toEqual({ type: 'prompt', sessionId: 's', promptId: 'p', prompt: 'hi' });
  });

  it('normalizes tool success and failure, picking the right target', () => {
    expect(claude.normalize('PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm t', description: 'x' } }))
      .toEqual({ type: 'tool', sessionId: 's', promptId: 'p', tool: 'Bash', target: 'npm t', ok: true });
    expect(claude.normalize('PostToolUseFailure', { ...base, tool_name: 'Edit', tool_input: { file_path: '/a.js' }, error: 'boom' }))
      .toMatchObject({ type: 'tool', tool: 'Edit', target: '/a.js', ok: false });
  });

  it('normalizes Stop flags without treating stop_hook_active as interrupt', () => {
    expect(claude.normalize('Stop', { ...base, stop_hook_active: true, background_tasks: [] }))
      .toEqual({ type: 'stop', sessionId: 's', promptId: 'p', interrupted: false, busy: false });
    expect(claude.normalize('Stop', { ...base, stop_hook_active: false, background_tasks: [{ id: 't' }] }).busy).toBe(true);
  });

  it('prefers hook_event_name over argv and ignores unknown events', () => {
    expect(claude.normalize('Stop', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' }).type).toBe('prompt');
    expect(claude.normalize('SessionStart', { ...base, hook_event_name: 'SessionStart' })).toBeNull();
  });

  it('renders context in the shape Claude Code reads, and nothing for non-prompt events', () => {
    const evt = { type: 'prompt' };
    expect(claude.render(evt, { context: null })).toBe('{}');
    expect(JSON.parse(claude.render(evt, { context: 'use this' })))
      .toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'use this' } });
    expect(JSON.parse(claude.render(evt, { context: 'use this', notice: 'Reflex recalled: "run build"' })))
      .toEqual({
        systemMessage: 'Reflex recalled: "run build"',
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'use this' },
      });
    expect(claude.render({ type: 'tool' }, { context: null })).toBe('');
  });
});
