/*
 * Provider signatures below are ported from the Gitleaks default config:
 * https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
 * Revision: b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b
 *
 * MIT License
 * Copyright (c) 2019 Zachary Rice
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Gitleaks uses Go's inline (?i) flag. These ports use JavaScript's i flag.
// Patterns are compiled once when the runtime loads.
const PROVIDER_RULES = [
  ["anthropic-api-key", /\b(sk-ant-api03-[a-zA-Z0-9_-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)/],
  ["aws-access-token", /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/],
  ["cloudflare-api-key", /[\w.-]{0,50}?(?:cloudflare)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9_-]{40})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["datadog-access-token", /[\w.-]{0,50}?(?:datadog)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-z0-9]{40})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["digitalocean-access-token", /\b(doo_v1_[a-f0-9]{64})(?:[\x60'"\s;]|\\[nr]|$)/],
  ["discord-api-token", /[\w.-]{0,50}?(?:discord)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([a-f0-9]{64})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["dropbox-short-lived-api-token", /[\w.-]{0,50}?(?:dropbox)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(sl\.[a-z0-9\-=_]{135})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["gcp-api-key", /\b(AIza[\w-]{35})(?:[\x60'"\s;]|\\[nr]|$)/],
  ["github-pat", /ghp_[0-9a-zA-Z]{36}/],
  ["gitlab-pat", /glpat-[\w-]{20}/],
  ["heroku-api-key-v2", /\b((HRKU-AA[0-9a-zA-Z_-]{58}))(?:[\x60'"\s;]|\\[nr]|$)/],
  ["mailgun-private-api-token", /[\w.-]{0,50}?(?:mailgun)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}(key-[a-f0-9]{32})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["npm-access-token", /\b(npm_[a-z0-9]{36})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["openai-api-key", /\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\x60'"\s;]|\\[nr]|$)/],
  ["pypi-upload-token", /pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}/],
  ["sendgrid-api-token", /\b(SG\.[a-z0-9=_\-.]{66})(?:[\x60'"\s;]|\\[nr]|$)/i],
  ["shopify-access-token", /shpat_[a-fA-F0-9]{32}/],
  ["slack-bot-token", /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/],
  ["stripe-access-token", /\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\x60'"\s;]|\\[nr]|$)/],
  ["twilio-api-key", /SK[0-9a-fA-F]{32}/],
  ["private-key", /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/i],
  ["jwt", /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?)(?:[\x60'"\s;]|\\[nr]|$)/],
];

const SENSITIVE_NAME =
  /(?:^|_)(?:API_?)?(?:KEY|TOKEN|SECRET|PASS|PASSWORD|AUTH|CREDENTIALS?|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN)(?:_|$)/i;
const ASSIGNMENT =
  /\b(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|"']+))(\s*)/g;
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:[^@\s/]+@/i;

function result(text, requiresEnv = [], unsafe = false) {
  return { text, requiresEnv: [...new Set(requiresEnv)], unsafe };
}

function replaceDetectedSecrets(input) {
  let text = input;
  let unsafe = false;

  for (const [id, regex] of PROVIDER_RULES) {
    let match;
    while ((match = regex.exec(text))) {
      const secret = match[1] || match[0];
      const offset = match[0].indexOf(secret);
      const start = match.index + offset;
      text = text.slice(0, start) + `[secret:${id}]` + text.slice(start + secret.length);
      unsafe = true;
    }
  }

  return { text, unsafe };
}

export function sanitizeText(input = "") {
  const detected = replaceDetectedSecrets(String(input));
  return result(detected.text, [], detected.unsafe);
}

export function sanitizeCommand(input = "") {
  let text = String(input);
  const requiresEnv = [];

  let removedAssignment = false;
  text = text.replace(ASSIGNMENT, (match, exported, name, double, single, bare, trailing, offset, source) => {
    const value = double ?? single ?? bare ?? "";
    const valueIsSecret =
      SENSITIVE_NAME.test(name) ||
      CREDENTIAL_URL.test(value) ||
      PROVIDER_RULES.some(([, regex]) => regex.test(value));
    if (!valueIsSecret) return match;

    requiresEnv.push(name);
    const before = source.slice(0, offset);
    const isCommandAssignment = exported || !before.trim() || /(?:&&|\|\||;)\s*$/.test(before);
    if (isCommandAssignment) {
      removedAssignment = true;
      return "";
    }
    // Keep the caller's quoting shape: a bare value may already sit inside
    // quotes, so adding our own would unbalance them.
    const placeholder = bare !== undefined ? `\${${name}}` : `"\${${name}}"`;
    return `${name}=${placeholder}${trailing}`;
  });

  text = text.replace(
    /'(\bAuthorization\s*:\s*Bearer\s+)([^']+)'/gi,
    (_match, prefix) => {
      requiresEnv.push("AUTH_TOKEN");
      return `"${prefix}\${AUTH_TOKEN}"`;
    },
  );
  text = text.replace(
    /'(\bAuthorization\s*:\s*Basic\s+)([^']+)'/gi,
    (_match, prefix) => {
      requiresEnv.push("BASIC_AUTH");
      return `"${prefix}\${BASIC_AUTH}"`;
    },
  );
  text = text.replace(
    /'([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@']+)(@[^']+)'/gi,
    (_match, prefix, _password, suffix) => {
      requiresEnv.push("PASSWORD");
      return `"${prefix}\${PASSWORD}${suffix}"`;
    },
  );

  text = text.replace(
    /(\bAuthorization\s*:\s*Bearer\s+)([^"'\s]+)/gi,
    (_match, prefix) => {
      requiresEnv.push("AUTH_TOKEN");
      return `${prefix}\${AUTH_TOKEN}`;
    },
  );
  text = text.replace(
    /(\bAuthorization\s*:\s*Basic\s+)([^"'\s]+)/gi,
    (_match, prefix) => {
      requiresEnv.push("BASIC_AUTH");
      return `${prefix}\${BASIC_AUTH}`;
    },
  );
  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    (_match, prefix, _password, suffix) => {
      requiresEnv.push("PASSWORD");
      return `${prefix}\${PASSWORD}${suffix}`;
    },
  );
  text = text.replace(
    /(--(?:password|passwd|token|secret|api-key|key)(?:=|\s+))(["']?)([^"'\s;&|]+)\2/gi,
    (_match, prefix, quote) => {
      const name = prefix
        .match(/^--([a-z-]+)/i)[1]
        .replace(/-/g, "_")
        .toUpperCase();
      requiresEnv.push(name);
      const safeQuote = quote === "'" ? '"' : quote;
      return `${prefix}${safeQuote}\${${name}}${safeQuote}`;
    },
  );

  if (removedAssignment) {
    // Removing an assignment can leave dangling or doubled separators.
    text = text
      .replace(/^\s*(?:&&|\|\||;)\s*/, "")
      .replace(/\s*(?:&&|\|\||;)\s*$/, "")
      .replace(/(?:&&|\|\||;)\s*(?=(?:&&|\|\||;))/g, "")
      .trim();
  }

  const detected = replaceDetectedSecrets(text);
  return result(detected.text, requiresEnv, detected.unsafe);
}
