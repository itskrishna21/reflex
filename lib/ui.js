import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { formatTokens } from "./cost.js";
import { readHits } from "./store.js";

const PAGE = fs.readFileSync(new URL("./ui-page.html", import.meta.url), "utf8");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatWhen(iso, now) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "";
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function shortSession(id) {
  const s = String(id || "");
  if (s.length <= 12) return s;
  return s.slice(0, 8);
}

function stepLabel(step) {
  if (!step) return "";
  if (typeof step === "string") return step;
  return `${step.t}: ${step.target || ""}`;
}

function formatRange(now) {
  const start = new Date(now.getTime() - WEEK_MS);
  const fmt = (d) =>
    d.toLocaleString("en-US", { day: "numeric", month: "short" });
  return `This week · ${fmt(start)} – ${fmt(now)}`;
}

export function buildUiData(reflexDir, { repo, now = new Date() } = {}) {
  const since = now.getTime() - WEEK_MS;
  const rows = readHits(reflexDir)
    .filter((h) => h && h.ts && new Date(h.ts).getTime() >= since)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const savedTotal = rows.reduce((n, h) => n + (Number(h.saved_tokens) || 0), 0);
  return {
    repo: repo || "repo",
    range: formatRange(now),
    hitCount: rows.length,
    savedLabel: formatTokens(savedTotal),
    hits: rows.map((h) => ({
      time: formatWhen(h.ts, now),
      session: shortSession(h.session),
      trigger: h.trigger || "procedure",
      saved: formatTokens(h.saved_tokens),
      steps: (h.steps || []).map(stepLabel).filter(Boolean),
    })),
  };
}

function renderPage(data) {
  return PAGE.replace("__DATA__", JSON.stringify(data).replace(/</g, "\\u003c"));
}

export function startUi({ cwd, port = 7373, open = false } = {}) {
  const root = cwd || process.cwd();
  const reflexDir = path.join(root, ".reflex");
  if (!fs.existsSync(reflexDir)) {
    throw new Error("No .reflex/ here. Run `npx agent-procedures init` first.");
  }
  const repo = path.basename(root);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const html = renderPage(buildUiData(reflexDir, { repo }));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = `http://127.0.0.1:${server.address().port}`;
      if (open) {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", addr] : [addr];
        execFile(cmd, args, () => {});
      }
      resolve({ server, url: addr });
    });
  });
}
