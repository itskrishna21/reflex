import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleEvent } from "./engine.js";
import { runGroomer } from "./groomer.js";
import { getHarness } from "./harnesses/index.js";

// Bundled to <repo>/.reflex/runtime.js. That file sits inside .reflex/.
const REFLEX_DIR = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function spawnGroomer() {
  const child = spawn(process.argv[0], [process.argv[1], "Groom"], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function run(harnessId, argv = process.argv.slice(2)) {
  const [eventName] = argv;
  if (!eventName) return;

  if (eventName === "Groom") {
    await runGroomer(path.join(REFLEX_DIR, "procedures.jsonl"));
    return;
  }

  const raw = await readStdin();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return;
  }

  const harness = getHarness(harnessId);
  const evt = harness.normalize(eventName, payload);
  if (!evt) return;

  const result = handleEvent(evt, REFLEX_DIR, { spawnGroomer });
  const out = harness.render(evt, result);
  if (out) process.stdout.write(out + "\n");
}
