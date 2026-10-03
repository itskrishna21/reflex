import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { runnerSource } from '../lib/runner.js';

const TEST_DIR = path.join(os.tmpdir(), `reflex-test-${Date.now()}-${Math.random()}`);
const REFLEX_DIR = path.join(TEST_DIR, '.reflex');
const TRACES_DIR = path.join(REFLEX_DIR, 'traces');
const PROCEDURES_FILE = path.join(REFLEX_DIR, 'procedures.jsonl');
describe('Reflex Runner Hot Path', () => {
  beforeEach(() => {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function runHook(eventName, payload) {
    try {
      // runner.js exports the hook script as a string; point its ROOT_DIR at the temp dir
      const mockedSource = runnerSource.replace(
        /const ROOT_DIR = path\.resolve\(__dirname, "[^"]*"\);/,
        `const ROOT_DIR = ${JSON.stringify(TEST_DIR)};`
      );

      
      const testRunnerPath = path.join(TEST_DIR, `runner-test-${Date.now()}-${Math.random()}.mjs`);
      fs.writeFileSync(testRunnerPath, mockedSource);

      const output = execSync(`node ${testRunnerPath} ${eventName}`, {
        cwd: TEST_DIR,
        input: JSON.stringify(payload),
        encoding: 'utf8'
      });
      return output;
    } catch (e) {
      console.error(e.stdout, e.stderr);
      throw e;
    }
  }

  it('UserPromptSubmit creates trace Goal and returns empty context on miss', () => {
    const out = runHook('UserPromptSubmit', {
      session_id: 's-1',
      prompt_id: 'p-1',
      prompt: 'do the thing'
    });
    
    expect(out.trim()).toBe('{}');
    
    const tracePath = path.join(TRACES_DIR, 's-1', 'p-1.jsonl');
    expect(fs.existsSync(tracePath)).toBe(true);
    const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0])).toEqual({ t: 'Goal', prompt: 'do the thing' });
  });

  it('PostToolUse appends to the trace file', () => {
    runHook('UserPromptSubmit', { session_id: 's-1', prompt_id: 'p-1', prompt: 'do the thing' });
    
    runHook('PostToolUse', {
      session_id: 's-1',
      prompt_id: 'p-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' }
    });

    const lines = fs.readFileSync(path.join(TRACES_DIR, 's-1', 'p-1.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1])).toEqual({ t: 'Bash', target: 'npm install', ok: true });
  });

  it('Stop with a successful trace writes a candidate to procedures.jsonl', () => {
    runHook('UserPromptSubmit', { session_id: 's-1', prompt_id: 'p-1', prompt: 'test task' });
    runHook('PostToolUse', {
      session_id: 's-1', prompt_id: 'p-1', tool_name: 'Bash', tool_input: { command: 'npm test' }
    });
    
    runHook('Stop', {
      session_id: 's-1', prompt_id: 'p-1', stop_hook_active: false, background_tasks: []
    });

    expect(fs.existsSync(PROCEDURES_FILE)).toBe(true);
    const lines = fs.readFileSync(PROCEDURES_FILE, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    
    const node = JSON.parse(lines[0]);
    expect(node.title).toBe('test task');
    expect(node.trigger).toBe('test task');
    expect(node.steps).toEqual([{ t: 'Bash', target: 'npm test' }]);
    expect(node.status).toBe('pending_review');
    
    // Trace should be cleaned up
    expect(fs.existsSync(path.join(TRACES_DIR, 's-1', 'p-1.jsonl'))).toBe(false);
  });

  it('Stop drops traces with unrecovered failures', () => {
    runHook('UserPromptSubmit', { session_id: 's-2', prompt_id: 'p-2', prompt: 'fail task' });
    runHook('PostToolUseFailure', {
      session_id: 's-2', prompt_id: 'p-2', tool_name: 'Bash', tool_input: { command: 'npm start' }
    });
    
    runHook('Stop', {
      session_id: 's-2', prompt_id: 'p-2', stop_hook_active: false, background_tasks: []
    });

    expect(fs.existsSync(PROCEDURES_FILE)).toBe(false);
  });

  it('Recall hits when a procedure trigger matches', () => {
    fs.mkdirSync(REFLEX_DIR, { recursive: true });
    fs.writeFileSync(PROCEDURES_FILE, JSON.stringify({
      id: 'abc',
      title: 'run build',
      trigger: 'run build',
      steps: [{ t: 'Bash', target: 'npm run build' }],
      enabled: true
    }) + '\n');

    const out = runHook('UserPromptSubmit', {
      session_id: 's-3', prompt_id: 'p-3', prompt: 'hey please run build for me'
    });

    const res = JSON.parse(out);
    expect(res.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(typeof res.hookSpecificOutput.additionalContext).toBe('string');
    expect(res.hookSpecificOutput.additionalContext).toContain('Reflex memory found a procedure');
    expect(res.hookSpecificOutput.additionalContext).toContain('npm run build');

    const lines = fs.readFileSync(path.join(TRACES_DIR, 's-3', 'p-3.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[1])).toEqual({ t: 'Recall', hit: 'abc' });
  });

  it('Diverging from a recall hit creates an alt edge', () => {
    fs.mkdirSync(REFLEX_DIR, { recursive: true });
    fs.writeFileSync(PROCEDURES_FILE, JSON.stringify({
      id: 'abc',
      title: 'run build',
      trigger: 'run build',
      steps: [{ t: 'Bash', target: 'npm run build' }],
      enabled: true
    }) + '\n');

    runHook('UserPromptSubmit', { session_id: 's-4', prompt_id: 'p-4', prompt: 'run build' });
    
    runHook('PostToolUse', {
      session_id: 's-4', prompt_id: 'p-4', tool_name: 'Bash', tool_input: { command: 'npm run build:prod' }
    });
    
    runHook('Stop', {
      session_id: 's-4', prompt_id: 'p-4', stop_hook_active: false, background_tasks: []
    });

    const lines = fs.readFileSync(PROCEDURES_FILE, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    
    const edge = JSON.parse(lines[1]);
    expect(edge.parent_id).toBe('abc');
    expect(edge.type).toBe('alt');
    expect(edge.steps).toEqual([{ t: 'Bash', target: 'npm run build:prod' }]);
    expect(edge.status).toBe('pending_review');
  });
});
