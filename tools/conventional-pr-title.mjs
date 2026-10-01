#!/usr/bin/env node
// Conventional-commit subject check for the release-please train (IRO-264).
//
// release-please derives every version bump and changelog section from the
// conventional-commit type of the subject that lands on `main`. A subject it
// cannot parse is not an error there: it is silently dropped, so the release PR
// quietly omits the change and the version does not move. This check is what
// turns that silent omission into a red required check on the pull request.
//
// Which subject actually lands is a repository setting, not a guess:
// `squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`, so GitHub uses the PR
// title for a multi-commit squash and the single commit's own subject when the
// PR has exactly one commit. Validating only the PR title would therefore pass a
// one-commit PR whose commit subject release-please cannot read. So: the PR title
// is always validated, and the head commit subject as well whenever
// PR_COMMIT_COUNT is 1.
//
// Inputs arrive through the environment (PR_TITLE, HEAD_COMMIT_SUBJECT,
// PR_COMMIT_COUNT) and are never interpolated into a shell string: a PR title is
// attacker-controlled text.
import { env, exit } from "node:process";

// The types release-please's changelog sections recognise. Keep this in step
// with the release-please configuration if its sections are ever customised.
export const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "revert",
];

// type(scope)!: subject
//   - scope is optional, and when present may not be empty
//   - `!` marks a breaking change and is optional
//   - exactly one ": " separates the prefix from the subject
const SUBJECT_PATTERN = new RegExp(
  `^(${CONVENTIONAL_TYPES.join("|")})(\\(([^()]+)\\))?(!)?: (.+)$`,
);

/**
 * Validate one subject line. Returns an array of human-readable problems; an
 * empty array means the subject is a conventional commit release-please parses.
 *
 * @param {string} subject the raw subject line
 * @param {string} label where the subject came from, for the message
 */
export function subjectFindings(subject, label) {
  if (typeof subject !== "string" || subject.trim() === "") {
    return [`${label} is empty`];
  }
  // A subject line is one line. A newline means a body leaked into it.
  if (/[\r\n]/.test(subject)) {
    return [`${label} must be a single line: ${JSON.stringify(subject)}`];
  }
  if (subject !== subject.trim()) {
    return [`${label} has leading or trailing whitespace: ${JSON.stringify(subject)}`];
  }

  const match = SUBJECT_PATTERN.exec(subject);
  if (!match) {
    return [
      `${label} is not a conventional commit: ${JSON.stringify(subject)}. ` +
        `Expected "type(scope)!: subject" with type one of ${CONVENTIONAL_TYPES.join(", ")}.`,
    ];
  }

  const findings = [];
  const scope = match[3];
  const description = match[5];
  if (scope !== undefined && scope.trim() === "") {
    findings.push(`${label} has an empty scope: ${JSON.stringify(subject)}`);
  }
  if (description.trim() === "") {
    findings.push(`${label} has an empty subject: ${JSON.stringify(subject)}`);
  }
  // A trailing period reads as a sentence in the changelog, where every other
  // entry is a phrase.
  if (description.endsWith(".")) {
    findings.push(`${label} must not end with a period: ${JSON.stringify(subject)}`);
  }
  return findings;
}

/**
 * Decide what to validate from the workflow environment and validate it.
 *
 * @param {Record<string, string | undefined>} environment
 */
export function titleFindings(environment) {
  const findings = subjectFindings(environment.PR_TITLE, "pull request title");

  // `squash_merge_commit_title: COMMIT_OR_PR_TITLE` lands the commit's own
  // subject when there is exactly one commit, so that subject is what
  // release-please will read.
  const rawCount = environment.PR_COMMIT_COUNT;
  if (rawCount !== undefined && rawCount !== "") {
    if (!/^\d+$/.test(rawCount)) {
      findings.push(`PR_COMMIT_COUNT is not a count: ${JSON.stringify(rawCount)}`);
    } else if (Number(rawCount) === 1) {
      findings.push(
        ...subjectFindings(
          environment.HEAD_COMMIT_SUBJECT,
          "single commit subject (squash lands this, not the pull request title)",
        ),
      );
    }
  }

  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = titleFindings(env);
  if (findings.length > 0) {
    console.error("conventional commit title check FAILED:");
    for (const finding of findings) console.error(`  - ${finding}`);
    exit(1);
  }
  console.log("ok release-please can parse the subject that will land on main");
}
