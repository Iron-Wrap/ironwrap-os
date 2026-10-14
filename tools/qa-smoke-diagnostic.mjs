import { open } from "node:fs/promises";

const STEP_NAMES = new Set([
  "health",
  "ready",
  "ingest_website",
  "ingest_website_replay",
  "ingest_estimate",
  "ingest_estimate_replay",
  "admin_envelopes",
  "admin_reconcile",
  "admin_status",
]);

export function diagnosticFromStderr(phase, exitStatus, stderr) {
  if (!["initial", "rollback"].includes(phase))
    throw new Error("invalid qa smoke phase");
  if (!Number.isInteger(exitStatus) || exitStatus < 1 || exitStatus > 255)
    throw new Error("invalid qa smoke exit status");
  const completed_steps = [];
  for (const line of stderr.slice(0, 65536).split(/\r?\n/)) {
    const match = /^([a-z_]+): HTTP ([1-5][0-9]{2})$/.exec(line);
    if (match && STEP_NAMES.has(match[1])) {
      completed_steps.push({ name: match[1], http_status: Number(match[2]) });
    }
  }
  return {
    proof: "ironwrap-qa-smoke-failure-v1",
    phase,
    exit_status: exitStatus,
    completed_steps,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [phase, exitStatus, input] = process.argv.slice(2);
  const file = await open(input, "r");
  let stderr;
  try {
    const bytes = Buffer.alloc(65536);
    const read = await file.read(bytes, 0, bytes.length, 0);
    stderr = bytes.toString("utf8", 0, read.bytesRead);
  } finally {
    await file.close();
  }
  const diagnostic = diagnosticFromStderr(phase, Number(exitStatus), stderr);
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
}
