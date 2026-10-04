import { describe, it, expect } from 'vitest';
import cursor from '../lib/harnesses/cursor.js';

const base = {
  conversation_id: 'c',
  generation_id: 'g',
  session_id: 'c',
  cwd: '/x',
};

describe('cursor harness', () => {
  it('normalizes beforeSubmitPrompt', () => {
    expect(cursor.normalize('beforeSubmitPrompt', {
      ...base,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'hi',
    })).toEqual({ type: 'prompt', sessionId: 'c', promptId: 'g', prompt: 'hi' });
  });

  it('normalizes tool success and failure, mapping Shell to Bash', () => {
    expect(cursor.normalize('postToolUse', {
      ...base,
      tool_name: 'Shell',
      tool_input: { command: 'npm t' },
    })).toEqual({ type: 'tool', sessionId: 'c', promptId: 'g', tool: 'Bash', target: 'npm t', ok: true });

    expect(cursor.normalize('postToolUseFailure', {
      ...base,
      tool_name: 'Write',
      tool_input: { file_path: '/a.js' },
      error_message: 'boom',
    })).toMatchObject({ type: 'tool', tool: 'Write', target: '/a.js', ok: false });
  });

  it('normalizes stop flags from status', () => {
    expect(cursor.normalize('stop', { ...base, status: 'completed', loop_count: 0 }))
      .toEqual({ type: 'stop', sessionId: 'c', promptId: 'g', interrupted: false, busy: false });
    expect(cursor.normalize('stop', { ...base, status: 'aborted' }).interrupted).toBe(true);
  });

  it('prefers hook_event_name over argv and ignores unknown events', () => {
    expect(cursor.normalize('stop', {
      ...base,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'x',
    }).type).toBe('prompt');
    expect(cursor.normalize('sessionStart', { ...base, hook_event_name: 'sessionStart' })).toBeNull();
  });

  it('renders additional_context for Cursor and always continues the prompt', () => {
    const evt = { type: 'prompt' };
    expect(JSON.parse(cursor.render(evt, { context: null }))).toEqual({ continue: true });
    expect(JSON.parse(cursor.render(evt, { context: 'use this' })))
      .toEqual({ continue: true, additional_context: 'use this' });
    expect(JSON.parse(cursor.render(evt, {
      context: 'use this',
      notice: 'Reflex recalled: "lint and fix"',
    }))).toEqual({
      continue: true,
      additional_context: 'Reflex recalled: "lint and fix"\n\nuse this',
    });
    expect(cursor.render({ type: 'tool' }, { context: null })).toBe('');
  });
});
