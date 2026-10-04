import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleEvent, GROOM_THRESHOLD } from '../lib/engine.js';

let DIR;
const pendingPath = () => path.join(DIR, 'pending.jsonl');
const procsPath = () => path.join(DIR, 'procedures.jsonl');
const pending = () => {
  if (!fs.existsSync(pendingPath())) return [];
  return fs.readFileSync(pendingPath(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};
const procs = () => {
  if (!fs.existsSync(procsPath())) return [];
  return fs.readFileSync(procsPath(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};
const trace = (s, p) => path.join(DIR, 'traces', s, `${p}.jsonl`);
const seed = (nodes) => fs.writeFileSync(procsPath(), nodes.map((n) => JSON.stringify(n)).join('\n') + '\n');
const seedPending = (nodes) => fs.writeFileSync(pendingPath(), nodes.map((n) => JSON.stringify(n)).join('\n') + '\n');

const prompt = (s, p, text) => handleEvent({ type: 'prompt', sessionId: s, promptId: p, prompt: text }, DIR);
const tool = (s, p, t, target, ok = true) => handleEvent({ type: 'tool', sessionId: s, promptId: p, tool: t, target, ok }, DIR);
const stop = (s, p, deps, flags = {}) => handleEvent({ type: 'stop', sessionId: s, promptId: p, ...flags }, DIR, deps);

beforeEach(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-engine-')); });
afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

describe('engine', () => {
  it('ignores events without session/prompt ids', () => {
    expect(handleEvent({ type: 'prompt', prompt: 'x' }, DIR)).toEqual({ context: null });
    expect(fs.existsSync(path.join(DIR, 'traces'))).toBe(false);
  });

  it('prompt opens a trace with the goal and returns no context on miss', () => {
    expect(prompt('s', 'p', 'do the thing')).toEqual({ context: null, notice: null });
    expect(JSON.parse(fs.readFileSync(trace('s', 'p'), 'utf8').trim())).toEqual({ t: 'Goal', prompt: 'do the thing' });
  });

  it('tool events append to the trace', () => {
    prompt('s', 'p', 'x');
    tool('s', 'p', 'Bash', 'npm install');
    tool('s', 'p', 'Bash', 'npm test', false);
    const lines = fs.readFileSync(trace('s', 'p'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines.slice(1)).toEqual([
      { t: 'Bash', target: 'npm install', ok: true },
      { t: 'Bash', target: 'npm test', ok: false },
    ]);
  });

  it('sanitizes commands before they touch disk and records required env vars', () => {
    const secret = 'postgres://admin:hunter2@db.prod:5432/app';
    prompt('s', 'p', 'deploy the migration');
    tool('s', 'p', 'Bash', `export DATABASE_URL=${secret} && npm run migrate`);

    const traceText = fs.readFileSync(trace('s', 'p'), 'utf8');
    expect(traceText).not.toContain('hunter2');
    expect(traceText).not.toContain(secret);

    stop('s', 'p');
    const [node] = pending();
    expect(node.steps).toEqual([{ t: 'Bash', target: 'npm run migrate' }]);
    expect(node.requires_env).toEqual(['DATABASE_URL']);
    expect(procs()).toEqual([]);
  });

  it('does not store an empty step when a command was only a sensitive assignment', () => {
    prompt('s', 'p', 'set the token');
    tool('s', 'p', 'Bash', 'export TOKEN=abc123');
    tool('s', 'p', 'Edit', 'src/a.js');

    stop('s', 'p');
    const [node] = pending();
    expect(node.steps).toEqual([{ t: 'Edit', target: 'src/a.js' }]);
    expect(node.requires_env).toEqual(['TOKEN']);
  });

  it('drops a turn with an unparameterizable secret and never writes it raw', () => {
    const token = `ghp_${'a1'.repeat(18)}`;
    prompt('s', 'p', 'configure the integration');
    tool('s', 'p', 'Bash', `echo ${token} > token.txt`);

    const traceText = fs.readFileSync(trace('s', 'p'), 'utf8');
    expect(traceText).not.toContain(token);
    expect(traceText).toContain('[secret:github-pat]');

    stop('s', 'p');
    expect(fs.existsSync(pendingPath())).toBe(false);
    expect(fs.existsSync(procsPath())).toBe(false);
  });

  it('sanitizes secrets in prompts before tracing and drops the turn', () => {
    const token = `ghp_${'b2'.repeat(18)}`;
    prompt('s', 'p', `deploy with ${token}`);

    const traceText = fs.readFileSync(trace('s', 'p'), 'utf8');
    expect(traceText).not.toContain(token);
    expect(traceText).toContain('[secret:github-pat]');

    tool('s', 'p', 'Bash', 'npm run deploy');
    stop('s', 'p');
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  it('stop writes a pending node to pending.jsonl and clears the trace', () => {
    prompt('s', 'p', 'test task');
    tool('s', 'p', 'Bash', 'cat README.md');
    tool('s', 'p', 'Bash', 'npm test');
    stop('s', 'p');

    const [node] = pending();
    expect(node).toMatchObject({ title: 'test task', trigger: 'test task', status: 'pending_review', enabled: true });
    expect(node.steps).toEqual([{ t: 'Bash', target: 'npm test' }]);
    expect(procs()).toEqual([]);
    expect(fs.existsSync(trace('s', 'p'))).toBe(false);
  });

  it('stop drops pure-read turns', () => {
    prompt('s', 'p', 'look around');
    tool('s', 'p', 'Bash', 'ls -la');
    tool('s', 'p', 'Read', '/x');
    stop('s', 'p');
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  it('stop drops unrecovered failures but keeps recovered ones', () => {
    prompt('s', 'a', 'fail');
    tool('s', 'a', 'Bash', 'npm start', false);
    stop('s', 'a');
    expect(fs.existsSync(pendingPath())).toBe(false);

    prompt('s', 'b', 'recover');
    tool('s', 'b', 'Bash', 'npm test', false);
    tool('s', 'b', 'Bash', 'npm test', true);
    stop('s', 'b');
    expect(pending()).toHaveLength(1);
  });

  it('stop drops interrupted or busy turns', () => {
    prompt('s', 'p', 'x');
    tool('s', 'p', 'Write', 'a.js');
    stop('s', 'p', {}, { interrupted: true });
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  it('stop drops continuation stumps that have no Goal line', () => {
    // Mimic PostToolUse after the first Stop deleted the trace: append-only, no Goal.
    tool('s', 'p', 'Write', 'a.js');
    stop('s', 'p');
    expect(fs.existsSync(pendingPath())).toBe(false);
    expect(fs.existsSync(trace('s', 'p'))).toBe(false);
  });

  it('recall matches trigger or alias from stable or pending', () => {
    seed([{ id: 'abc', trigger: 'run build', aliases: ['compile it'], steps: [{ t: 'Bash', target: 'npm run build' }], enabled: true }]);

    const r1 = prompt('s', 'p1', 'hey please run build for me');
    expect(r1.context).toContain('npm run build');
    expect(r1.notice).toBe('Reflex recalled: "run build"');
    expect(JSON.parse(fs.readFileSync(trace('s', 'p1'), 'utf8').trim().split('\n')[1])).toEqual({ t: 'Recall', hit: 'abc' });

    expect(prompt('s', 'p2', 'can you compile it').context).toContain('npm run build');
    expect(prompt('s', 'p3', 'unrelated')).toEqual({ context: null, notice: null });

    seedPending([{ id: 'pend', trigger: 'ship release', steps: [{ t: 'Bash', target: 'npm run release' }], enabled: true, status: 'pending_review' }]);
    expect(prompt('s', 'p4', 'please ship release').context).toContain('npm run release');
  });

  it('recall names required environment variables', () => {
    seed([{
      id: 'abc',
      trigger: 'run migration',
      steps: [{ t: 'Bash', target: 'npm run migrate' }],
      requires_env: ['DATABASE_URL'],
      enabled: true,
    }]);

    const { context } = prompt('s', 'p', 'please run migration');
    expect(context).toContain('Requires environment: DATABASE_URL');
  });

  it('recall skips disabled nodes and edges, includes alt text', () => {
    seed([
      { id: 'off', trigger: 'run build', steps: [{ t: 'Bash', target: 'nope' }], enabled: false },
      { id: 'abc', trigger: 'run build', steps: [{ t: 'Bash', target: 'npm run build' }], enabled: true },
      { parent_id: 'abc', type: 'alt', steps: [{ t: 'Bash', target: 'npm run build:prod' }] },
    ]);
    const { context } = prompt('s', 'p', 'run build');
    expect(context).not.toContain('nope');
    expect(context).toContain('Alternative path that worked:\n- Bash: npm run build:prod');
  });

  it('diverging from a recall hit writes an alt edge to pending; same steps write nothing', () => {
    seed([{ id: 'abc', trigger: 'run build', steps: [{ t: 'Bash', target: 'npm run build' }], enabled: true }]);

    prompt('s', 'p1', 'run build');
    tool('s', 'p1', 'Bash', 'npm run build');
    stop('s', 'p1');
    expect(procs()).toHaveLength(1);
    expect(pending()).toHaveLength(0);

    prompt('s', 'p2', 'run build');
    tool('s', 'p2', 'Bash', 'npm run build:prod');
    stop('s', 'p2');
    const edge = pending()[0];
    expect(edge).toMatchObject({ parent_id: 'abc', type: 'alt', status: 'pending_review' });
    expect(edge.id).toBeTruthy();
    expect(edge.steps).toEqual([{ t: 'Bash', target: 'npm run build:prod' }]);
  });

  it('spawns the groomer once pending nodes reach the threshold', () => {
    const spawnGroomer = vi.fn();
    for (let i = 0; i < GROOM_THRESHOLD; i++) {
      prompt('s', `p${i}`, `task ${i}`);
      tool('s', `p${i}`, 'Write', `f${i}.js`);
      stop('s', `p${i}`, { spawnGroomer });
    }
    expect(spawnGroomer).toHaveBeenCalledTimes(1);
    expect(pending()).toHaveLength(GROOM_THRESHOLD);
  });
});
