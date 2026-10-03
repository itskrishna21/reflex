import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleEvent, GROOM_THRESHOLD } from '../lib/engine.js';

let DIR;
const procs = () => fs.readFileSync(path.join(DIR, 'procedures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const trace = (s, p) => path.join(DIR, 'traces', s, `${p}.jsonl`);
const seed = (nodes) => fs.writeFileSync(path.join(DIR, 'procedures.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n') + '\n');

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
    expect(prompt('s', 'p', 'do the thing')).toEqual({ context: null });
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

  it('stop writes a pending node from a clean mutating trace and clears the trace', () => {
    prompt('s', 'p', 'test task');
    tool('s', 'p', 'Bash', 'cat README.md');
    tool('s', 'p', 'Bash', 'npm test');
    stop('s', 'p');

    const [node] = procs();
    expect(node).toMatchObject({ title: 'test task', trigger: 'test task', status: 'pending_review', enabled: true });
    expect(node.steps).toEqual([{ t: 'Bash', target: 'npm test' }]); // pure reads dropped
    expect(fs.existsSync(trace('s', 'p'))).toBe(false);
  });

  it('stop drops pure-read turns', () => {
    prompt('s', 'p', 'look around');
    tool('s', 'p', 'Bash', 'ls -la');
    tool('s', 'p', 'Read', '/x');
    stop('s', 'p');
    expect(fs.existsSync(path.join(DIR, 'procedures.jsonl'))).toBe(false);
  });

  it('stop drops unrecovered failures but keeps recovered ones', () => {
    prompt('s', 'a', 'fail');
    tool('s', 'a', 'Bash', 'npm start', false);
    stop('s', 'a');
    expect(fs.existsSync(path.join(DIR, 'procedures.jsonl'))).toBe(false);

    prompt('s', 'b', 'recover');
    tool('s', 'b', 'Bash', 'npm test', false);
    tool('s', 'b', 'Bash', 'npm test', true);
    stop('s', 'b');
    expect(procs()).toHaveLength(1);
  });

  it('stop drops interrupted or busy turns', () => {
    prompt('s', 'p', 'x');
    tool('s', 'p', 'Write', 'a.js');
    stop('s', 'p', {}, { interrupted: true });
    expect(fs.existsSync(path.join(DIR, 'procedures.jsonl'))).toBe(false);
  });

  it('recall matches trigger or alias, returns context, records the hit', () => {
    seed([{ id: 'abc', trigger: 'run build', aliases: ['compile it'], steps: [{ t: 'Bash', target: 'npm run build' }], enabled: true }]);

    const r1 = prompt('s', 'p1', 'hey please run build for me');
    expect(r1.context).toContain('npm run build');
    expect(JSON.parse(fs.readFileSync(trace('s', 'p1'), 'utf8').trim().split('\n')[1])).toEqual({ t: 'Recall', hit: 'abc' });

    expect(prompt('s', 'p2', 'can you compile it').context).toContain('npm run build');
    expect(prompt('s', 'p3', 'unrelated').context).toBeNull();
  });

  it('recall skips disabled nodes and edges, includes alt/on_fail text', () => {
    seed([
      { id: 'off', trigger: 'run build', steps: [{ t: 'Bash', target: 'nope' }], enabled: false },
      { id: 'abc', trigger: 'run build', steps: [{ t: 'Bash', target: 'npm run build' }], enabled: true },
      { parent_id: 'abc', type: 'alt', steps: [{ t: 'Bash', target: 'npm run build:prod' }] },
      { parent_id: 'abc', type: 'on_fail', steps: [{ t: 'Bash', target: 'rm -rf node_modules' }] },
    ]);
    const { context } = prompt('s', 'p', 'run build');
    expect(context).not.toContain('nope');
    expect(context).toContain('Alternative path that worked:\n- Bash: npm run build:prod');
    expect(context).toContain('recovery worked:\n- Bash: rm -rf node_modules');
  });

  it('diverging from a recall hit writes an alt edge; same steps write nothing', () => {
    seed([{ id: 'abc', trigger: 'run build', steps: [{ t: 'Bash', target: 'npm run build' }], enabled: true }]);

    prompt('s', 'p1', 'run build');
    tool('s', 'p1', 'Bash', 'npm run build');
    stop('s', 'p1');
    expect(procs()).toHaveLength(1);

    prompt('s', 'p2', 'run build');
    tool('s', 'p2', 'Bash', 'npm run build:prod');
    stop('s', 'p2');
    const edge = procs()[1];
    expect(edge).toMatchObject({ parent_id: 'abc', type: 'alt', status: 'pending_review' });
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
  });
});
