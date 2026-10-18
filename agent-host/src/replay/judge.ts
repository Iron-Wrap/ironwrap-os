// The independent judge's request and the test of its answer (agent-host/evals/judge.md). The
// judge's system text is judge.md itself; everything it scores goes in as data behind a per-call
// random marker, like a run's data block, because the case and the transcript carry untrusted text.

import { randomBytes } from "node:crypto";
import type { JsonSchema } from "../gateway/types.ts";
import { DIMENSIONS, type Deterministic, type EvalCase, type Rubric, type Transcript } from "./evals.ts";

const perDimension = (schema: JsonSchema) => ({
  type: "object",
  additionalProperties: false,
  required: [...DIMENSIONS],
  properties: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, schema])),
});

/**
 * judge.md "Output". Scores are plain numbers so no provider's schema mode can refuse the answer;
 * isValidJudgement holds them to 0, 0.5 and 1, and anything else is re-asked.
 */
export const JUDGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["case_id", "repetition", "scores", "reasons", "catastrophes"],
  properties: {
    case_id: { type: "string", maxLength: 200 },
    repetition: { type: "integer", minimum: 1 },
    scores: perDimension({ type: "number" }),
    reasons: perDimension({ type: "string", maxLength: 1000 }),
    catastrophes: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "evidence"],
        properties: { id: { type: "string", maxLength: 80 }, evidence: { type: "string", maxLength: 2000 } },
      },
    },
  },
};

export interface JudgeInput {
  item: EvalCase;
  rubric: Rubric;
  catastrophes: unknown;
  transcript: Transcript;
  deterministic: Deterministic;
}

/** judge.md "You receive": the case, the rubric, the vocabulary, the transcript, the deterministic results. */
export function judgePrompt(input: JudgeInput, nonce = randomBytes(12).toString("hex")): string {
  const { item, rubric, transcript, deterministic } = input;
  const data = {
    case: item,
    rubric: { weights: rubric.weights, specialist_checks: rubric.specialist_checks },
    catastrophes: input.catastrophes,
    transcript,
    deterministic: { caps: deterministic.caps, notes: deterministic.notes, catastrophes: deterministic.catastrophes, run_failed: deterministic.run_failed },
  };
  return [
    `Score repetition ${transcript.repetition} of case ${JSON.stringify(item.id)}. The case, the rubric, the catastrophe vocabulary, the transcript and the deterministic results are in the data block.`,
    `The data block runs from BEGIN DATA ${nonce} to END DATA ${nonce}.`,
    `BEGIN DATA ${nonce}`,
    JSON.stringify(data, null, 2),
    `END DATA ${nonce}`,
  ].join("\n");
}

const SCORE_VALUES = new Set([0, 0.5, 1]);

/** The answer mergeJudgement accepts: this case and repetition, scores of 0, 0.5 or 1, catastrophes with ids. */
export function isValidJudgement(output: unknown, caseId: string, repetition: number): boolean {
  if (!isObject(output) || output.case_id !== caseId || output.repetition !== repetition) return false;
  const scores = output.scores;
  if (!isObject(scores) || !DIMENSIONS.every((dimension) => SCORE_VALUES.has(scores[dimension] as number))) return false;
  return Array.isArray(output.catastrophes) && output.catastrophes.every((entry) => isObject(entry) && typeof entry.id === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
