export const runnerSource = `#!/usr/bin/env node

/**
 * Reflex Hook Runner
 * Injected by agent-procedures init.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../");
const REFLEX_DIR = path.join(ROOT_DIR, ".reflex");
const TRACES_DIR = path.join(REFLEX_DIR, "traces");
const PROCEDURES_FILE = path.join(REFLEX_DIR, "procedures.jsonl");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", () => resolve(data));
  });
}

function ensureTraceDir(sessionId) {
  const dir = path.join(TRACES_DIR, sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getTraceFile(sessionId, promptId) {
  return path.join(TRACES_DIR, sessionId, \`\${promptId}.jsonl\`);
}

function writeTraceLine(sessionId, promptId, lineObj) {
  const dir = ensureTraceDir(sessionId);
  const file = path.join(dir, \`\${promptId}.jsonl\`);
  fs.appendFileSync(file, JSON.stringify(lineObj) + "\\n", "utf8");
}

function isMutating(t, target) {
  if (t === "Edit" || t === "Write" || t === "NotebookEdit") return true;
  if (t === "Bash" || t === "bash") {
    const cmd = (target || "").trim();
    if (!cmd) return false;
    const firstWord = cmd.split(" ")[0];
    const readOnly = ["cat", "ls", "git", "pwd", "head", "tail", "echo", "grep", "find"];
    if (readOnly.includes(firstWord)) {
      if (firstWord === "git" && (cmd.includes(" commit") || cmd.includes(" push") || cmd.includes(" add") || cmd.includes(" rm") || cmd.includes(" mv"))) {
        return true;
      }
      return false;
    }
    return true;
  }
  return false;
}

// Segment 4: Judge
function judgeCandidate(lines, payload) {
  if (!lines || lines.length === 0) return false;

  const hasMutating = lines.some(l => l.t !== "Goal" && l.t !== "Recall" && isMutating(l.t, l.target));
  if (!hasMutating) return false;

  if (payload.stop_hook_active === true) return false;
  if (payload.background_tasks && payload.background_tasks.length > 0) return false;
  if (payload.type === "StopFailure" || payload.type === "interrupt") return false;

  const failed = new Map();
  for (const l of lines) {
    if (l.t === "Goal" || l.t === "Recall") continue;
    const key = \`\${l.t}|\${l.target}\`;
    if (l.ok === false) {
      failed.set(key, true);
    } else if (l.ok === true) {
      failed.delete(key);
    }
  }
  
  if (failed.size > 0) return false;

  return true;
}

// Segment 6: Synthesize
function synthesize(lines, promptText) {
  const steps = [];
  for (const l of lines) {
    if (l.t === "Goal" || l.t === "Recall") continue;
    if (l.ok === false) continue;
    
    if (l.t === "Bash" || l.t === "bash") {
      const firstWord = (l.target || "").trim().split(" ")[0];
      const pureReads = ["cat", "ls", "pwd", "head", "tail"];
      if (pureReads.includes(firstWord)) continue;
      if (l.target.startsWith("git status") || l.target.startsWith("git log") || l.target.startsWith("git diff")) continue;
    }
    if (l.t === "Read" || l.t === "View") continue;

    steps.push({ t: l.t, target: l.target });
  }

  return {
    title: promptText,
    trigger: promptText,
    steps
  };
}

function writeProcedure(node) {
  if (!fs.existsSync(PROCEDURES_FILE)) {
    fs.writeFileSync(PROCEDURES_FILE, "", "utf8");
  }
  fs.appendFileSync(PROCEDURES_FILE, JSON.stringify(node) + "\\n", "utf8");
}

function spawnGroomer() {
  // Segment 7.5: Detached worker
  const child = spawn(process.argv[0], [process.argv[1], 'Groom'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

async function main() {
  const eventName = process.argv[2];
  if (!eventName) {
    return;
  }

  if (eventName === "Groom") {
    import('./groomer.js').then(({ runGroomer }) => {
      runGroomer(PROCEDURES_FILE)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    }).catch(() => process.exit(1));
    return;
  }

  const stdinData = await readStdin();
  if (!stdinData) return;
  
  let payload;
  try {
    payload = JSON.parse(stdinData);
  } catch (e) {
    return;
  }

  const sessionId = payload.session_id || payload.sessionId;
  const promptId = payload.prompt_id || payload.promptId;
  const prompt = payload.prompt;

  if (eventName === "UserPromptSubmit") {
    let additionalContext = null;
    let recallHit = null;

    if (sessionId && promptId) {
      const dir = ensureTraceDir(sessionId);
      const file = path.join(dir, \`\${promptId}.jsonl\`);
      fs.writeFileSync(file, JSON.stringify({ t: "Goal", prompt: prompt }) + "\\n", "utf8");
      
      // Segment 8: Recall logic
      if (fs.existsSync(PROCEDURES_FILE)) {
        const procs = fs.readFileSync(PROCEDURES_FILE, "utf8").split("\\n").filter(Boolean).map(l => JSON.parse(l));
        // simple matching
        for (const p of procs) {
          if (p.enabled === false) continue;
          if (p.parent_id) continue; // Only match root nodes for trigger text

          let match = false;
          if (prompt && p.trigger && prompt.toLowerCase().includes(p.trigger.toLowerCase())) {
            match = true;
          }
          if (!match && p.aliases && Array.isArray(p.aliases)) {
            if (p.aliases.some(a => prompt.toLowerCase().includes(a.toLowerCase()))) match = true;
          }

          if (match) {
            recallHit = p.id;
            let stepsText = p.steps.map(s => \`- \${s.t}: \${s.target}\`).join("\\n");
            
            let altEdge = procs.find(edge => edge.parent_id === p.id && edge.type === "alt" && edge.enabled !== false);
            let onFailEdge = procs.find(edge => edge.parent_id === p.id && edge.type === "on_fail" && edge.enabled !== false);
            
            if (altEdge) {
              stepsText += "\\n\\nAlternative path that worked:\\n" + altEdge.steps.map(s => \`- \${s.t}: \${s.target}\`).join("\\n");
            }
            if (onFailEdge) {
              stepsText += "\\n\\nIf it fails, this recovery worked:\\n" + onFailEdge.steps.map(s => \`- \${s.t}: \${s.target}\`).join("\\n");
            }

            additionalContext = \`Reflex memory found a procedure for this task:\\n\\n\${stepsText}\\n\\nFollow these steps instead of figuring it out from scratch.\`;
            break;
          }
        }
      }
      
      if (recallHit) {
        fs.appendFileSync(file, JSON.stringify({ t: "Recall", hit: recallHit }) + "\\n", "utf8");
      }
    }
    // Claude Code: additionalContext must be a string, nested under hookSpecificOutput with hookEventName.
    console.log(JSON.stringify(
      additionalContext
        ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
        : {}
    ));
  } 
  else if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
    if (sessionId && promptId) {
      const ok = eventName === "PostToolUse";
      const toolName = payload.toolName || payload.tool_name || payload.name;
      const toolInput = payload.toolInput || payload.tool_input || payload.input || {};
      
      let target = "";
      if (toolName === "Bash" || toolName === "bash") {
        target = toolInput.command || "";
      } else if (toolInput.target) {
        target = toolInput.target;
      } else if (toolInput.file_path) {
        target = toolInput.file_path;
      } else if (toolInput.path) {
        target = toolInput.path;
      } else if (typeof toolInput === "string") {
        target = toolInput;
      }

      writeTraceLine(sessionId, promptId, { t: toolName, target, ok });
    }
  }
  else if (eventName === "Stop") {
    if (!sessionId || !promptId) return;
    const traceFile = getTraceFile(sessionId, promptId);
    if (!fs.existsSync(traceFile)) return;

    const linesRaw = fs.readFileSync(traceFile, "utf8").split("\\n").filter(Boolean);
    const lines = linesRaw.map(l => JSON.parse(l));

    const isCandidate = judgeCandidate(lines, payload);
    
    let goalPrompt = "";
    let recallHit = null;
    for (const l of lines) {
      if (l.t === "Goal") goalPrompt = l.prompt;
      if (l.t === "Recall" && l.hit) recallHit = l.hit;
    }

    if (isCandidate) {
      const procedure = synthesize(lines, goalPrompt);
      if (procedure.steps.length > 0) {
        // Segment 5: Capture gate
        if (!recallHit) {
          // new root node
          const node = {
            id: Math.random().toString(36).slice(2, 11),
            title: procedure.title,
            trigger: procedure.trigger,
            steps: procedure.steps,
            enabled: true,
            hits: 0,
            last_used_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            status: "pending_review"
          };
          writeProcedure(node);
        } else {
          // recall hit. did agent deviate?
          let parentSteps = [];
          if (fs.existsSync(PROCEDURES_FILE)) {
             const parentNode = fs.readFileSync(PROCEDURES_FILE, "utf8")
               .split("\\n").filter(Boolean).map(l => JSON.parse(l))
               .find(p => p.id === recallHit);
             if (parentNode) parentSteps = parentNode.steps;
          }
          
          const sameSteps = parentSteps.length === procedure.steps.length && 
            parentSteps.every((s, i) => s.t === procedure.steps[i].t && s.target === procedure.steps[i].target);
          
          if (!sameSteps) {
            // new edge
            const edge = {
              parent_id: recallHit,
              type: "alt",
              steps: procedure.steps,
              created_at: new Date().toISOString(),
              status: "pending_review"
            };
            writeProcedure(edge);
          }
        }

        // Segment 7.5 trigger
        if (fs.existsSync(PROCEDURES_FILE)) {
          const allProcs = fs.readFileSync(PROCEDURES_FILE, "utf8").split("\\n").filter(Boolean).map(l => JSON.parse(l));
          const pendingCount = allProcs.filter(p => p.status === "pending_review").length;
          if (pendingCount >= 5) {
            spawnGroomer();
          }
        }
      }
    }

    try {
      fs.unlinkSync(traceFile);
    } catch (e) {}
  }

  // End of main
}

await main();
`;
