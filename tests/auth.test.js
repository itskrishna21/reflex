import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { resolveCredentials, PROVIDERS } from '../lib/providers.js';
import { login, status } from '../lib/auth.js';

let HOME;
const CREDS = () => path.join(HOME, 'credentials.json');

function writeCreds(obj) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CREDS(), JSON.stringify(obj));
}

function io(input = '') {
  let out = '';
  return {
    stdin: Readable.from([input]),
    stdout: new Writable({ write(c, _e, cb) { out += c; cb(); } }),
    output: () => out,
  };
}

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-auth-'));
  process.env.REFLEX_HOME = HOME;
  for (const p of Object.values(PROVIDERS)) delete process.env[p.envVar];
});

afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  delete process.env.REFLEX_HOME;
  vi.unstubAllGlobals();
});

describe('resolveCredentials', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveCredentials({})).toBeNull();
  });

  it('uses the first provider with an env var when there is no file', () => {
    const r = resolveCredentials({ GEMINI_API_KEY: 'AIza1' });
    expect(r).toEqual({ provider: 'gemini', apiKey: 'AIza1', model: 'gemini-3.5-flash-lite', source: 'env' });
  });

  it('uses the stored provider and key when no env var is set', () => {
    writeCreds({ defaultProvider: 'openai', providers: { openai: { apiKey: 'sk-file', model: 'gpt-x' } } });
    const r = resolveCredentials({});
    expect(r).toEqual({ provider: 'openai', apiKey: 'sk-file', model: 'gpt-x', source: 'file' });
  });

  it('env var for the stored provider wins over the stored key', () => {
    writeCreds({ defaultProvider: 'openai', providers: { openai: { apiKey: 'sk-file', model: 'gpt-x' } } });
    const r = resolveCredentials({ OPENAI_API_KEY: 'sk-env', ANTHROPIC_API_KEY: 'sk-ant-ignored' });
    expect(r.apiKey).toBe('sk-env');
    expect(r.source).toBe('env');
    expect(r.model).toBe('gpt-x');
  });

  it('throws on a corrupt file instead of silently falling through', () => {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CREDS(), '{not json');
    expect(() => resolveCredentials({})).toThrow(/Failed to parse/);
  });
});

describe('auth login', () => {
  it('verifies the key, then saves it with 0600 perms and the default model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const t = io('AIzaTESTKEY\n');
    await login(['--provider', 'gemini', '--key-stdin'], t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('AIzaTESTKEY');

    const saved = JSON.parse(fs.readFileSync(CREDS(), 'utf8'));
    expect(saved.defaultProvider).toBe('gemini');
    expect(saved.providers.gemini).toEqual({ apiKey: 'AIzaTESTKEY', model: 'gemini-3.5-flash-lite' });
    expect(fs.statSync(CREDS()).mode & 0o777).toBe(0o600);
    expect(t.output()).toContain('ok');
  });

  it('does not save a key the provider rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => '',
    }));

    await expect(login(['--provider', 'openai', '--key-stdin'], io('sk-bad\n')))
      .rejects.toThrow(/OpenAI rejected the key.*401/);
    expect(fs.existsSync(CREDS())).toBe(false);
  });

  it('rejects an unknown provider before reading a key', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(login(['--provider', 'mistral', '--key-stdin'], io('k\n')))
      .rejects.toThrow(/Unsupported provider "mistral"/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires --provider when stdin is not a TTY', async () => {
    await expect(login(['--key-stdin'], io('k\n'))).rejects.toThrow(/--provider is required/);
  });

  it('keeps other providers when adding a new one', async () => {
    writeCreds({ version: 1, defaultProvider: 'openai', providers: { openai: { apiKey: 'sk-1', model: 'm' } } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await login(['--provider', 'anthropic', '--key-stdin', '--model', 'claude-custom'], io('sk-ant-2'));

    const saved = JSON.parse(fs.readFileSync(CREDS(), 'utf8'));
    expect(saved.defaultProvider).toBe('anthropic');
    expect(saved.providers.openai.apiKey).toBe('sk-1');
    expect(saved.providers.anthropic).toEqual({ apiKey: 'sk-ant-2', model: 'claude-custom' });
  });
});

describe('auth status', () => {
  it('reports not configured', () => {
    const t = io();
    status(t, HOME);
    expect(t.output()).toMatch(/Not configured/);
  });

  it('shows provider, masked key, source and last groomer error', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-abcdefghijkl';
    fs.mkdirSync(path.join(HOME, '.reflex'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.reflex', 'worker.log'), '[t1] first\n[t2] Anthropic API error: 401\n');

    const t = io();
    status(t, HOME);
    const out = t.output();
    expect(out).toContain('Provider: Anthropic');
    expect(out).toContain('sk-a...ijkl');
    expect(out).not.toContain('abcdefgh');
    expect(out).toContain('env ANTHROPIC_API_KEY');
    expect(out).toContain('Last groomer error: [t2] Anthropic API error: 401');
  });
});
