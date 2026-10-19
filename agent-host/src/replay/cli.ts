// Operator entry points; both spend the configured sign-ins, so neither runs in CI.
//
//   npm run qualify -- --stage <id> --start|--resume [--output <dir>]
//   npm run replay -- --specialist <id> --case <id> [--repetition <n>] [--output <dir>]
//
// A stage starts or resumes only on the explicit flag (`start_and_resume`). Arguments are checked
// and the eval tree validated before local sign-ins are read. Exit codes: 0 complete, 2 refused,
// 3 paused (resume later), 4 stopped; progress goes to stdout as JSON lines.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { applyLocalEnv } from "../host/env.ts";
import { SpecialistLoadError } from "../host/specialists.ts";
import { loadEnvironment, validateEvals, type ReplayEnvironment } from "./evals.ts";
import { replayCase, runStage, StageRefusal } from "./stage.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const USAGE = [
  "usage: npm run qualify -- --stage <id> --start|--resume [--output <dir>]",
  "       npm run replay -- --specialist <id> --case <id> [--repetition <n>] [--output <dir>]",
].join("\n");
const EXIT = { complete: 0, refused: 2, paused: 3, stopped: 4 } as const;

// The exit code is set, never forced: stdout to a pipe is asynchronous on macOS, so a forced exit
// could cut the last JSON line.
process.exitCode = await main(process.argv.slice(2));

async function main([command, ...args]: string[]): Promise<number> {
  const refuse = (message: string) => {
    process.stderr.write(`${message}\n${USAGE}\n`);
    return EXIT.refused;
  };
  if (command !== "qualify" && command !== "replay") return refuse(`unknown command ${command ?? "(none)"}`);
  let values: { stage?: string; start?: boolean; resume?: boolean; output?: string; specialist?: string; case?: string; repetition?: string };
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        stage: { type: "string" },
        start: { type: "boolean" },
        resume: { type: "boolean" },
        output: { type: "string" },
        specialist: { type: "string" },
        case: { type: "string" },
        repetition: { type: "string" },
      },
    }));
  } catch (error) {
    return refuse((error as Error).message);
  }
  const repetition = values.repetition === undefined ? 1 : Number(values.repetition);
  if (command === "qualify") {
    if (!values.stage) return refuse("--stage is required");
    if (values.start === values.resume) return refuse("a stage starts or resumes only on an explicit signal: pass exactly one of --start and --resume");
    if (values.specialist !== undefined || values.case !== undefined || values.repetition !== undefined) return refuse("--specialist, --case and --repetition belong to replay");
  } else {
    if (!values.specialist || !values.case) return refuse("--specialist and --case are required");
    if (!Number.isInteger(repetition) || repetition < 1) return refuse("--repetition must be a positive integer");
    if (values.stage !== undefined || values.start !== undefined || values.resume !== undefined) return refuse("--stage, --start and --resume belong to qualify");
  }

  // Each setup step fails as a refusal on one line, never a stack trace, and in this order: no
  // local sign-in is read before the arguments, the stage and the eval tree are accepted.
  let environment: ReplayEnvironment;
  try {
    environment = loadEnvironment(ROOT, process.env.AGENT_HOST_GATEWAY_CONFIG);
  } catch (error) {
    return refuse(`cannot load the eval tree: ${firstLine(error)}`);
  }
  if (values.stage && !environment.config.stages.some((stage) => stage.id === values.stage)) {
    return refuse(`unknown stage ${values.stage}; stages: ${environment.config.stages.map((stage) => stage.id).join(", ")}`);
  }
  if (values.specialist && !environment.catalog.specialists.has(values.specialist)) return refuse(`unknown specialist ${values.specialist}`);
  // No spend on a tree the validator refuses: cases, allowlists, rubrics and the qualification config.
  let failures: string[];
  try {
    ({ failures } = validateEvals(ROOT, { requireComplete: true }));
  } catch (error) {
    return refuse(`cannot validate the eval tree: ${firstLine(error)}`);
  }
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 20)) process.stderr.write(`fail: ${failure}\n`);
    return refuse(`the eval tree does not validate (${failures.length} failure(s)); run node agent-host/evals/validate.mjs --require-complete`);
  }
  try {
    applyLocalEnv(process.env);
  } catch (error) {
    return refuse(`cannot read the local sign-ins: ${firstLine(error)}`);
  }
  // npm runs scripts in the package directory; a relative --output means where the operator typed it.
  const outputDir = values.output ? resolve(process.env.INIT_CWD ?? process.cwd(), values.output) : resolve(ROOT, environment.config.output_dir);
  const abort = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => abort.abort());
  const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const common = { environment, outputDir, env: process.env, signal: abort.signal, log };
  try {
    if (command === "qualify") {
      const { state, stageDir } = await runStage({ ...common, stage: values.stage as string, mode: values.start ? "start" : "resume", mainSha: headSha() });
      log({ event: "report", json: `${stageDir}/report.json`, markdown: `${stageDir}/report.md` });
      return state.status === "complete" ? EXIT.complete : state.status === "paused" ? EXIT.paused : EXIT.stopped;
    }
    const result = await replayCase({ ...common, specialistId: values.specialist as string, caseId: values.case as string, repetition });
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    log({ event: "replay", status: result.status, merged: result.merged, transcript: result.transcript, halts: result.halts, warnings: result.warnings });
    return EXIT[result.status];
  } catch (error) {
    if (error instanceof SpecialistLoadError) return refuse(firstLine(error));
    if (!(error instanceof StageRefusal)) throw error;
    process.stderr.write(`${error.message}\n`);
    return error.code === "paused" ? EXIT.paused : EXIT.refused;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

function headSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
