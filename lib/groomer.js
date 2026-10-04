import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, resolveCredentials } from "./providers.js";

// Silent Failure Logging
function logError(proceduresFile, msg) {
  const reflexDir = path.dirname(proceduresFile);
  const logFile = path.join(reflexDir, "worker.log");
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`, "utf8");
  } catch (e) {
    // nowhere to log, silently fail
  }
}

export async function runGroomer(proceduresFile) {
  let creds;
  try {
    creds = resolveCredentials();
  } catch (e) {
    logError(proceduresFile, e.message);
    return;
  }
  if (!creds) {
    logError(
      proceduresFile,
      "No API key found. Run `npx agent-procedures auth login` or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.",
    );
    return;
  }
  const { provider, apiKey, model } = creds;

  if (!fs.existsSync(proceduresFile)) return;

  const lines = fs
    .readFileSync(proceduresFile, "utf8")
    .split("\n")
    .filter(Boolean);
  const nodes = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

  const pending = nodes.filter((n) => n.status === "pending_review");
  if (pending.length === 0) return;

  const prompt = `
Here are ${pending.length} new execution nodes/edges added by a coding agent.

<edges>
${JSON.stringify(pending, null, 2)}
</edges>

For each item:
1) Did the agent verify this worked? (e.g. ran a test, checked a log). If it just wrote code and blindly stopped without checking, it's risky.
2) Is this a generic/reusable workflow, or a one-off anomaly?
If it's unverified and risky, or a pure anomaly, decide to DROP it.
If it's good, KEEP it.

If you KEEP a root node (has no parent_id), generate 5-10 semantic aliases (synonyms) for its 'trigger' text so we can match variations of the user's prompt later.

Return ONLY a JSON array of objects with this schema:
[
  {
    "id": "node_id",
    "action": "KEEP" | "DROP",
    "aliases": ["alias1", "alias2"] // only if KEEP and root node
  }
]
`;

  let responseText;
  try {
    responseText = await PROVIDERS[provider].complete(apiKey, model, prompt);
  } catch (err) {
    logError(proceduresFile, err.message);
    return;
  }

  let actions = [];
  try {
    const jsonStr = responseText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    actions = JSON.parse(jsonStr);
  } catch (e) {
    logError(proceduresFile, "Failed to parse LLM JSON response.");
    return;
  }

  const newNodes = [];
  for (const node of nodes) {
    if (node.status === "pending_review") {
      const actionDef = actions.find((a) => a.id === node.id);
      if (actionDef) {
        if (actionDef.action === "DROP") {
          continue;
        } else {
          delete node.status;
          if (!node.parent_id && actionDef.aliases) {
            node.aliases = actionDef.aliases;
          }
        }
      }
    }
    newNodes.push(node);
  }

  // Atomic Writes for the Groomer
  const newFileContent =
    newNodes.map((n) => JSON.stringify(n)).join("\n") + "\n";
  const tmpFile = proceduresFile + ".tmp";
  try {
    fs.writeFileSync(tmpFile, newFileContent, "utf8");
    fs.renameSync(tmpFile, proceduresFile);
  } catch (err) {
    logError(proceduresFile, `Failed atomic write: ${err.message}`);
  }
}
