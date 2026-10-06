import { describe, it, expect } from 'vitest';
import { calculateCoverage, expandRecallQuery, recall, shouldExpandRecallQuery, tokenize } from '../lib/recall.js';

describe('tokenize', () => {
  it('lowercases, splits on punctuation, and drops stop words', () => {
    expect(tokenize('Please fix the auth-token bug!')).toEqual(['fix', 'auth', 'token', 'bug']);
  });
});

describe('calculateCoverage', () => {
  it('scores trigger coverage without diluting on long prompts', () => {
    const prompt = tokenize('can you please start fixing the auth tokens in login');
    expect(calculateCoverage(prompt, 'fix auth token')).toBeGreaterThanOrEqual(0.75);
  });

  it('accepts unidirectional prefix morphology', () => {
    const prompt = tokenize('fixing tokens now');
    expect(calculateCoverage(prompt, 'fix token')).toBe(1);
  });

  it('does not let short prompt tokens hijack longer trigger words', () => {
    const prompt = tokenize('post the java patch');
    expect(calculateCoverage(prompt, 'postgres javascript')).toBe(0);
  });

  it('rejects thin single-word matches like build/error', () => {
    expect(calculateCoverage(tokenize('please build this'), 'build')).toBe(0);
    expect(calculateCoverage(tokenize('see the error'), 'error')).toBe(0);
  });

  it('allows a single high-value word of length >= 6', () => {
    expect(calculateCoverage(tokenize('run postgres locally'), 'postgres')).toBe(1);
  });

  it('does not require 75% of a long stored trigger', () => {
    const stored =
      'add receipt photos to an expense client compresses to under 200kb put to r2 store the object key';
    const prompt = tokenize(
      'also compress receipts like the expense flow we already have, 200kb, r2, object key, plus settings copy',
    );
    expect(calculateCoverage(prompt, stored)).toBeGreaterThan(0);
  });
});

describe('recall', () => {
  it('picks the highest scoring root and attaches alt text', () => {
    const procs = [
      {
        id: 'weak',
        trigger: 'fix auth',
        steps: [{ t: 'Bash', target: 'echo weak' }],
        enabled: true,
      },
      {
        id: 'strong',
        trigger: 'fix auth token bug',
        steps: [{ t: 'Bash', target: 'echo strong' }],
        enabled: true,
      },
      {
        parent_id: 'strong',
        type: 'alt',
        steps: [{ t: 'Bash', target: 'echo alt' }],
      },
      {
        id: 'off',
        trigger: 'fix auth token bug',
        steps: [{ t: 'Bash', target: 'echo off' }],
        enabled: false,
      },
    ];

    const hit = recall('please fix the auth token bug', procs);
    expect(hit.node.id).toBe('strong');
    expect(hit.text).toContain('echo strong');
    expect(hit.text).toContain('echo alt');
    expect(hit.text).not.toContain('echo off');
    expect(hit.text).not.toContain('echo weak');
    expect(hit.notice).toBe('Reflex recalled: "fix auth token bug"');
  });

  it('matches via alias when the main trigger does not', () => {
    const hit = recall('compile it please', [
      {
        id: 'abc',
        trigger: 'run production build pipeline',
        aliases: ['compile it'],
        steps: [{ t: 'Bash', target: 'npm run build' }],
        enabled: true,
      },
    ]);
    expect(hit.node.id).toBe('abc');
  });

  it('returns null when nothing clears the floor', () => {
    expect(
      recall('unrelated chat', [
        { id: 'abc', trigger: 'migrate postgres', steps: [{ t: 'Bash', target: 'x' }], enabled: true },
      ]),
    ).toBeNull();
  });
});

describe('expandRecallQuery', () => {
  it('expands thin or anaphoric prompts, not a new task with its own nouns', () => {
    expect(shouldExpandRecallQuery('do the same for splits')).toBe(true);
    expect(shouldExpandRecallQuery('pick option A')).toBe(true);
    expect(shouldExpandRecallQuery('yes')).toBe(true);
    expect(shouldExpandRecallQuery('unrelated')).toBe(false);
    expect(shouldExpandRecallQuery('fix login csrf')).toBe(false);
    expect(shouldExpandRecallQuery('add receipt photos to expenses')).toBe(false);
  });

  it('joins prior turns onto an anaphoric prompt', () => {
    const q = expandRecallQuery('do the same for splits', [
      { role: 'user', text: 'please add receipt upload to expenses' },
      { role: 'agent', text: 'done' },
      { role: 'user', text: 'do the same for splits' },
    ]);
    expect(q).toContain('add receipt upload');
    expect(q.startsWith('do the same for splits')).toBe(true);
  });
});
