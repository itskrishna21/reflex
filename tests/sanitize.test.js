import { describe, expect, it } from "vitest";
import { sanitizeCommand, sanitizeText } from "../lib/sanitize.js";

describe("sanitize", () => {
  it("promotes sensitive assignments to required environment variables", () => {
    expect(
      sanitizeCommand(
        "export DATABASE_URL=postgres://admin:hunter2@db.prod:5432/app && npm run migrate",
      ),
    ).toEqual({
      text: "npm run migrate",
      requiresEnv: ["DATABASE_URL"],
      unsafe: false,
    });
  });

  it("removes consecutive sensitive assignments without leaving dangling separators", () => {
    expect(
      sanitizeCommand("cd app && export TOKEN=abc && export SECRET=def && npm start"),
    ).toEqual({
      text: "cd app && npm start",
      requiresEnv: ["TOKEN", "SECRET"],
      unsafe: false,
    });
    expect(sanitizeCommand("export TOKEN=abc123")).toEqual({
      text: "",
      requiresEnv: ["TOKEN"],
      unsafe: false,
    });
  });

  it("keeps quoting balanced when the assignment is an argument", () => {
    expect(sanitizeCommand('echo "DATABASE_URL=postgres://a:b@h/db" >> .env').text).toBe(
      'echo "DATABASE_URL=${DATABASE_URL}" >> .env',
    );
    expect(sanitizeCommand('echo TOKEN="abc 123" >> .env').text).toBe(
      'echo TOKEN="${TOKEN}" >> .env',
    );
    expect(sanitizeCommand("sed -i 's/PASSWORD=old/PASSWORD=new/' config.ini").text).toBe(
      "sed -i 's/PASSWORD=${PASSWORD}' config.ini",
    );
  });

  it("parameterizes authorization headers and URL passwords", () => {
    expect(
      sanitizeCommand(
        'curl -H "Authorization: Bearer sk-live-SECRET123" postgres://admin:hunter2@db.prod/app',
      ),
    ).toEqual({
      text: 'curl -H "Authorization: Bearer ${AUTH_TOKEN}" postgres://admin:${PASSWORD}@db.prod/app',
      requiresEnv: ["AUTH_TOKEN", "PASSWORD"],
      unsafe: false,
    });
  });

  it("uses expandable placeholders when the original secret was single-quoted", () => {
    expect(
      sanitizeCommand(
        "curl -H 'Authorization: Bearer token123' 'postgres://admin:hunter2@db.prod/app'",
      ),
    ).toEqual({
      text: 'curl -H "Authorization: Bearer ${AUTH_TOKEN}" "postgres://admin:${PASSWORD}@db.prod/app"',
      requiresEnv: ["AUTH_TOKEN", "PASSWORD"],
      unsafe: false,
    });
  });

  it("detects vendored provider signatures that cannot be parameterized", () => {
    const token = `ghp_${"a1".repeat(18)}`;
    const result = sanitizeText(`paste ${token} into the website`);
    expect(result.text).toBe("paste [secret:github-pat] into the website");
    expect(result.unsafe).toBe(true);
    expect(result.text).not.toContain(token);
  });

  it("detects private keys", () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(80)}\n-----END PRIVATE KEY-----`;
    const result = sanitizeText(key);
    expect(result).toMatchObject({
      text: "[secret:private-key]",
      unsafe: true,
    });
  });

  it("detects the vendored provider signatures", () => {
    const samples = [
      `sk-ant-api03-${"a".repeat(93)}AA`,
      `AKIA${"A2".repeat(8)}`,
      `cloudflare = ${"a".repeat(40)}`,
      `datadog = ${"b".repeat(40)}`,
      `doo_v1_${"c".repeat(64)}`,
      `discord = ${"d".repeat(64)}`,
      `dropbox = sl.${"e".repeat(135)}`,
      `AIza${"f".repeat(35)}`,
      `ghp_${"g".repeat(36)}`,
      `glpat-${"h".repeat(20)}`,
      `HRKU-AA${"i".repeat(58)}`,
      `mailgun = key-${"a".repeat(32)}`,
      `npm_${"j".repeat(36)}`,
      `sk-${"k".repeat(20)}T3BlbkFJ${"l".repeat(20)}`,
      `pypi-AgEIcHlwaS5vcmc${"m".repeat(50)}`,
      `SG.${"n".repeat(66)}`,
      `shpat_${"a".repeat(32)}`,
      "xoxb-1234567890-1234567890-abc",
      `sk_live_${"o".repeat(10)}`,
      `SK${"a".repeat(32)}`,
    ];

    for (const sample of samples) {
      const sanitized = sanitizeText(sample);
      expect(sanitized.unsafe, sample).toBe(true);
      expect(sanitized.text, sample).not.toContain(sample);
    }
  });

  it("does not flag ordinary developer identifiers", () => {
    const harmless = [
      "git checkout 3f2a9c81b7e4d0a56c2f9e1b8d7a4c3e2f1a0b9c",
      "docker pull node@sha256:9e1b8d7a4c3e2f1a0b9c3f2a9c81b7e4d0a56c2f9e1b8d7a4c3e2f1a0b9c",
      "rm -rf /tmp/550e8400-e29b-41d4-a716-446655440000",
      "npm install package@1.2.3",
      'echo "a  b"',
      "cat <<EOF > notes.txt\nfirst line\n\nthird line\nEOF",
      "please deploy\n\nthen run the migration   carefully",
    ];

    for (const text of harmless) {
      expect(sanitizeCommand(text)).toEqual({
        text,
        requiresEnv: [],
        unsafe: false,
      });
    }
  });
});
