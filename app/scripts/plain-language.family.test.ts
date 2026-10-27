import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync, types } from "@babel/core";
import { describe, expect, it } from "vitest";

import { SPECIALISTS } from "../src/components/ai/words";

/**
 * The plain-language guard: Z2 of `design/ZERO-LEARNING-GATE.md`, enforced on source.
 *
 * Staff and customers get no training, so the words on a primary surface are the whole manual.
 * This test parses the app's screens and copy modules with Babel (the parser ESLint already
 * uses), reads only strings a person can see, and checks five rules:
 *
 * - banned-term: the gate's banned words (work package, outbox, tenant, SHA, ...), the wider
 *   jargon list of the zero-training audit (snapshot, observed, readback, JSON, v3, ...) and the
 *   AI team's system facts (action classes A0 to A3 and H, run ids, hashes), which only System
 *   details may show;
 * - unlabelled-code: an id, reference, code, digest or hash rendered with no plain label, and a
 *   literal code ("IW-1001") with no plain word right before it ("Job IW-1001");
 * - raw-error-text: an error's own `.message` used as words (show `messageFor(error)` instead;
 *   only `src/lib/plain-error.ts`, which decides what may reach a screen, reads one);
 * - machine-name: a machine key turned into words with underscores swapped for spaces;
 * - agent-name: the AI team named anything but its IRW-R8 names. The face is the tenant's brand
 *   ("IronWrap", reached through "Ask IronWrap"), the team is the "AI team", and each specialist is
 *   its "AI <job>" display name from docs/AI-TEAM-CONTRACT.md (src/components/ai/words.ts, checked
 *   against the contract). "Assistant", HELM, Hermes, Newo, Postiz, "agent(s)" and "AI" anywhere
 *   outside those names are banned.
 *
 * What counts as copy: JSX text; string attributes a person reads (aria-label, title,
 * placeholder, alt, label, message, ...) and every string prop of the shared state and notice
 * primitives; strings under copy keys in objects (label, title, message, reason, fallback, ...)
 * and sentences anywhere in an object; branches of conditionals rendered in JSX; arguments of
 * the error and status setters and of `new PlainError` (in any module under src, not only the
 * screens); and returned strings. Class names, keys, ids, hrefs, values, comparisons, switch
 * cases, types, imports, `<code>` and `<kbd>` text are never copy.
 *
 * The allowlist is structural: everything inside `<SystemDetails>` (or a
 * `<details data-system-details>`) is exempt, and a bare `<details>` exempts nothing. A rare
 * real exception takes `// plain-language-allow: <rule> - <reason>` on the line above, and
 * every escape is counted.
 *
 * Day one is green through a ratchet: `plain-language.baseline.json` holds today's count per
 * file and rule. A count above its baseline fails and lists every hit with how to fix it. A
 * count below its baseline also fails, so the fixing change shrinks the file in the same diff:
 * `UPDATE_PLAIN_BASELINE=1 npx vitest run scripts/plain-language.family.test.ts` lowers counts
 * to what is found and never raises one. Raising a count is a hand edit a reviewer can see.
 *
 * Soft words (source, receipt, evidence, loaded, ledger, the server, ...) are reported, never
 * failed, so a later change can promote one once its screens are clean. Set
 * `PLAIN_LANGUAGE_REPORT=1` to print them per file.
 *
 * Known blind spots:
 * - copy written on the Worker (`workers-bus/src/now-read-model.ts` titles, API `message`
 *   fields) and other server-provided text is not seen here;
 * - CSS `content:` strings and pictures of text;
 * - strings assembled at runtime beyond the template and conditional shapes read here, and
 *   data-driven labels (a raw status printed from a variable);
 * - the error-name heuristic: `.message` counts only on objects named like errors (error,
 *   err, caught, `query.error`, `lastError`), so a renamed variable, a computed member or a
 *   validator's issue text (`issues[0].message`) is not seen, and a helper that title-cases is
 *   counted where it is defined, not where it is called;
 * - the lists of setters (`setError`, ...) and attribute names that carry copy are closed: a new
 *   setter (`setNotice`) or attribute (`submitLabel`) is read only once it is added to them;
 * - one banned term counts per string, so new jargon added to a string that is already counted
 *   does not raise its count.
 */

type RuleId = "banned-term" | "unlabelled-code" | "raw-error-text" | "machine-name" | "agent-name";
type CountedRule = RuleId | "allow-escape";

const RULES: readonly RuleId[] = [
  "banned-term",
  "unlabelled-code",
  "raw-error-text",
  "machine-name",
  "agent-name",
];
const COUNTED: readonly CountedRule[] = [...RULES, "allow-escape"];

const HOW_TO_FIX: Record<CountedRule, string> = {
  "banned-term":
    "Use the words a foreman or office manager uses (design/ZERO-LEARNING-GATE.md, Z2). System facts go inside <SystemDetails> (src/components/ui/system-details.tsx).",
  "unlabelled-code":
    'Put the plain label first: <RefTag kind="job" id={...} /> renders "Job IW-1001"; a literal code needs its word right before it ("Coil PMS-2231"). Otherwise move the code inside <SystemDetails>.',
  "raw-error-text":
    "Show messageFor(error) from src/lib/plain-error.ts. Throw PlainError for words written for people; an error's own message is never shown.",
  "machine-name":
    "Map known keys to words with an explicit Record and hide unknown keys (see humanizeFieldName in src/field/field-formatting.ts).",
  "agent-name":
    'Name the AI team the IRW-R8 way (design/system-v2/AI-PRIMITIVES.md): the face is "IronWrap" ("Ask IronWrap"), the team is the "AI team", a specialist is its display name ("AI estimator", src/components/ai/words.ts). Product names (HELM, Hermes, Newo, Postiz) go inside <SystemDetails>.',
  "allow-escape":
    "Escapes are counted so they cannot grow quietly. Fix the copy instead, or raise this file's allow-escape count by hand in the baseline so a reviewer sees it.",
};

interface Term {
  term: string;
  pattern: RegExp;
  suggest: string;
  hits: string[];
  misses: string[];
}

const term = (
  name: string,
  pattern: RegExp,
  suggest: string,
  hits: string[],
  misses: string[],
): Term => ({ term: name, pattern, suggest, hits, misses });

const systemOnly = "keep it inside System details";

/** The gate's banned list, then the audit's wider jargon list. One match per string counts. */
const BANNED: readonly Term[] = [
  term(
    "work package",
    /\bwork[ -]?packages?\b/i,
    "work plan",
    ["Issue Work Package", "two work packages"],
    ["work plan", "a package of work"],
  ),
  term(
    "disposition",
    /\bdispositions?\b/i,
    "what was decided",
    ["NCR disposition", "Dispositions"],
    ["disposal", "dispose of it"],
  ),
  term(
    "derived phase",
    /\bderived phases?\b/i,
    "stage",
    ["Derived phase: install"],
    ["phase", "derived from the quote"],
  ),
  term(
    "outbox",
    /\boutbox(?:es)?\b/i,
    "saved on this phone",
    ["the JSON outbox", "Outbox"],
    ["out of the box", "inbox"],
  ),
  term(
    "idempotency",
    /\bidempoten\w*/i,
    "it will not count twice",
    ["the same idempotency key", "Idempotent retry"],
    ["identity", "important"],
  ),
  term(
    "effect",
    /\beffects?\b/i,
    "what it changes",
    ["before any inventory effect", "Side effects"],
    ["effective date", "effectively", "affect"],
  ),
  term(
    "capability",
    /\bcapabilit(?:y|ies)\b/i,
    "feature, or what is turned on",
    ["the capability signal", "Capabilities you cannot reach"],
    ["capable", "can do"],
  ),
  term(
    "principal",
    /\bprincipals?\b/i,
    "person",
    ["the signed-in principal", "Principals"],
    ["principle", "principally"],
  ),
  term("receipt hash", /\breceipt hash(?:es)?\b/i, systemOnly, ["Receipt hash"], ["receipt"]),
  term(
    "digest",
    /\bdigests?\b/i,
    systemOnly,
    ["its SHA-256 digest", "Digest"],
    ["digestible", "digital"],
  ),
  term(
    "SHA",
    /\bSHA(?:-?\d+)?\b/,
    systemOnly,
    ["Design SHA-256", "SHA256", "SHA"],
    ["shade", "Shall", "sha"],
  ),
  term(
    "envelope",
    /\benvelopes?\b/i,
    "the saved details",
    ["Source envelope", "envelopes"],
    ["envelop", "develop"],
  ),
  term(
    "payload",
    /\bpayloads?\b/i,
    "the saved details",
    ["payload is invalid", "Payloads"],
    ["pay load", "payment"],
  ),
  term(
    "tenant",
    /\btenants?\b/i,
    "company",
    ["this tenant", "the tenant's item", "Tenants"],
    ["tenancy", "tent", "maintenance"],
  ),
  term(
    "grant",
    /\bgrants?\b/i,
    "who can use it",
    ["explicit grants", "Grant access"],
    ["grantor", "granted", "granite"],
  ),
  term(
    "qualifying",
    /\bqualifying\b/i,
    "counted",
    ["2 qualifying sources"],
    ["qualified installer", "quality"],
  ),
  term(
    "snapshot",
    /\bsnapshots?\b/i,
    "copy",
    ["Approved snapshot version", "snapshots"],
    ["snap", "shot"],
  ),
  term(
    "observed",
    /\bobserved\b/i,
    "seen, or recorded",
    ["Material lots observed", "Observed lead record"],
    ["observation", "observe"],
  ),
  term(
    "projection",
    /\bprojections?\b/i,
    "list",
    ["Awaiting projection", "native projections"],
    ["project", "projected"],
  ),
  term(
    "read-back",
    /\bread[- ]?backs?\b/i,
    "checked",
    ["authenticated readback", "Read back from the ledger", "read-back"],
    ["read the back", "ready", "bread back"],
  ),
  term(
    "read model",
    /\bread models?\b/i,
    "list",
    ["Read model generated"],
    ["read the model", "modelled"],
  ),
  term(
    "source coverage",
    /\bsource coverage\b/i,
    "all figures are in",
    ["Source coverage complete"],
    ["source", "coverage"],
  ),
  term("source sum", /\bsource sums?\b/i, "total", ["incomplete source sum"], ["sum", "source"]),
  term("OIDC", /\bOIDC\b/, systemOnly, ["Google OIDC"], ["oidc-client", "void"]),
  term("OAuth", /\bOAuth\b/i, systemOnly, ["the OAuth callback"], ["oath", "author"]),
  term("JSON", /\bJSON\b/, systemOnly, ["goes up as JSON"], ["json-file", "Jason"]),
  term("MCP", /\bMCP\b/, systemOnly, ["The desktop MCP"], ["MCPX", "mcp"]),
  term("R2", /\bR2\b/, systemOnly, ["r2 reference stored in R2"], ["R22", "r2"]),
  term("D1", /\bD1\b/, systemOnly, ["the live D1 authority"], ["D12", "d1"]),
  term("CSRF", /\bCSRF\b/, systemOnly, ["CSRF checks"], ["csrf_failed"]),
  term("Worker", /\bWorker\b/, systemOnly, ["the Worker resolves it"], ["worker", "Workers'"]),
  term("BFF", /\bBFF\b/, systemOnly, ["the BFF"], ["BFFS", "buff"]),
  term(
    "version label",
    /\bv(?:\d+|\{x\})(?![\w{])|\bversion (?:\d|\{x\})/i,
    "move the version into System details",
    ["Current request v4", "Safety plan · v{x}", "Version 2", "Review empty draft V4"],
    ["vinyl", "v-groove", "conversion 2", "version history"],
  ),
  term(
    "action class",
    /\b(?:A[0-3]|[Cc]lass H)\b/,
    "the delegation words (Reads and watches, Prepares, Acts within your limits, Asks first, People only); the class stays in System details",
    ["Class A3", "an A2 action", "class H"],
    ["A4 sheet", "A10", "AA", "class Hours"],
  ),
  term(
    "run id",
    /\brun[ _-]?ids?\b/i,
    systemOnly,
    ["Run ID", "run_id", "two run ids"],
    ["running", "rerun", "run identity"],
  ),
  // Not inside a kebab or snake identifier ("csp-hash" names a build plugin, not a fact).
  term(
    "hash",
    /(?<![-_])\bhash(?:es)?\b(?![-_])/i,
    systemOnly,
    ["Request hash", "hashes", "Hash"],
    ["hashtag", "rehash", "hashed", "boot-style-csp-hash", "request_hash"],
  ),
];

/**
 * The AI team's names on primary surfaces (IRW-R8, design/system-v2/AI-PRIMITIVES.md): "IronWrap"
 * and "Ask IronWrap" for the face, the "AI team", and the specialists' display names. "AI" is
 * allowed only as the start of one of those names, in the receipt panel's title, "What the AI
 * did", and as "IronWrap's AI" when a screen says it is off or not answering (TEMPLATES 4.6,
 * orchestrator ruling under IRW-R8d); everything else is a system name.
 */
const AI_NAMES = [
  "AI team",
  ...Object.values(SPECIALISTS)
    .map((specialist) => specialist.name as string)
    .filter((name) => name.startsWith("AI ")),
];
const AI_NAME_ENDS = AI_NAMES.map((name) => name.slice(3)).join("|");
const AI_OUTSIDE_NAMES = new RegExp(
  `(?<!\\bWhat the )(?<!\\bIronWrap['’]s (?=AI is (?:off|not answering)\\b))\\bAI\\b(?! (?:${AI_NAME_ENDS})\\b)|\\bWhat the AI\\b(?! (?:did|${AI_NAME_ENDS})\\b)`,
);
const IRW_R8 = '"IronWrap", "Ask IronWrap", "AI team" or the specialist\'s name ("AI estimator")';
const AGENTS: readonly Term[] = [
  term(
    "Assistant",
    /\bassistants?\b/i,
    IRW_R8,
    ["Ask the Assistant", "your assistant drafted it"],
    ["assistance", "assist", "assisted"],
  ),
  term("HELM", /\bHELM\b/, IRW_R8, ["Ask HELM"], ["helm", "Helmet"]),
  term("Hermes", /\bHermes\b/, IRW_R8, ["Hermes desktop text pilot"], ["hermes-run"]),
  term("Newo", /\bNewo\b/, IRW_R8, ["answered by Newo"], ["new", "Newton"]),
  term("Postiz", /\bPostiz\b/, IRW_R8, ["sent by Postiz"], ["post", "posting"]),
  term("agent", /\bagents?\b/i, IRW_R8, ["Agent authorship", "two agents"], ["agency", "reagent"]),
  term(
    "AI",
    AI_OUTSIDE_NAMES,
    IRW_R8,
    [
      "the AI drafted it",
      "AI Estimator",
      "desktop AI client",
      "AI teammate",
      "What the AI does",
      "IronWrap's AI drafted this quote",
    ],
    [
      "AI estimator",
      "the AI team",
      "What the AI did",
      "IronWrap's AI is off.",
      "IronWrap’s AI is not answering since 09:40",
      "AI customer care at Iron Wrap Exteriors",
      "Drafted by AI market analyst",
      "AI estimator's draft",
      "Ask IronWrap",
      "Aim",
      "said",
    ],
  ),
];

/** Reported only (warn tier) until a batch has cleaned its screens and promotes one. */
const SOFT: readonly Term[] = [
  term("source", /\bsources?\b/i, "", ["Source limits"], ["resource"]),
  // "See receipt for {object}" is the receipt link's own words (AI-PRIMITIVES, link words).
  term(
    "receipt",
    /(?<!\bSee )\breceipts?\b/i,
    "",
    ["Approval receipt"],
    ["receive", "See receipt for the invoice"],
  ),
  term("evidence", /\bevidence\b/i, "", ["Evidence reference"], ["evident"]),
  term("loaded", /\bloaded\b/i, "", ["No items in this loaded list"], ["load"]),
  term("ledger", /\bledgers?\b/i, "", ["Approval ledger"], ["ledge"]),
  term("manifest", /\bmanifests?\b/i, "", ["Approved manifest missing"], ["manifestly"]),
  term("identity", /\bidentit(?:y|ies)\b/i, "", ["Exact stock identity"], ["identify"]),
  term("reconcile", /\breconcil\w*/i, "", ["Reconciliation required"], ["reconsider"]),
  term("authenticated", /\bauthenticated\b/i, "", ["authenticated readback"], ["authentic"]),
  term("the server", /\bthe server\b/i, "", ["The server got this check-in."], ["the service"]),
];

/** The plain words a code may carry right before it ("Coil PMS-2231"). */
const CODE_LABEL =
  /\b(?:Job|Lead|Quote|Invoice|Coil|Lot|Quality problem|Survey reading|Cut list|Change order|Vehicle|Equipment|Service call|Call|Person|Supply order|Order|Record|Proposal)\s+$/;
const CODE_LITERAL = /\b(?!SHA-)[A-Z]{2,5}-\d{2,}\b/g;
const CODE_NAME =
  /(?:^|_)(?:id|ref|code|digest|hash|sha256)$|[a-z0-9](?:Id|Ref|Code|Digest|Hash|Sha256)$/;
const ERROR_NAME = /^(?:e|err|error|caught|exception|failure|cause)$|[a-z]Error$/;

/** Attributes whose string a person reads, on any element. */
const COPY_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "message",
  "hint",
  "text",
  "summary",
  "caption",
  "legend",
  "tooltip",
  "nextAction",
  "personPath",
  "stateLabel",
  "eyebrow",
  "detail",
  "next",
]);
/** The shared primitives whose every string prop is copy. */
const COPY_COMPONENTS = new Set([
  "EmptyState",
  "ErrorState",
  "OffState",
  "UnconfiguredState",
  "NoAccessState",
  "Notice",
  "QueueRow",
  "Tile",
  "IdentityTile",
  "JobFact",
  "DispatchFact",
  "CommercialFact",
]);
const SKIP_ATTRS = new Set([
  "className",
  "summaryClassName",
  "class",
  "id",
  "key",
  "role",
  "type",
  "href",
  "to",
  "value",
  "defaultValue",
  "htmlFor",
  "name",
  "method",
  "action",
  "rel",
  "target",
  "src",
  "srcSet",
  "sizes",
  "style",
  "tone",
  "kind",
  "variant",
  "size",
  "side",
  "align",
  "autoComplete",
  "inputMode",
  "pattern",
  "accept",
  "form",
  "lang",
  "dir",
  "tabIndex",
  "params",
  "search",
  "hash",
  "icon",
]);
const COPY_KEYS = new Set([
  "label",
  "title",
  "message",
  "description",
  "detail",
  "text",
  "summary",
  "hint",
  "reason",
  "next",
  "nextStep",
  "placeholder",
  "helper",
  "caption",
  "empty",
  "error",
  "fallback",
  "eyebrow",
  "headline",
]);
const SETTERS = new Set([
  "setError",
  "setStatus",
  "setMessage",
  "setFormError",
  "setActionError",
  "setFailure",
  "setRefusal",
  "setBlocker",
  "setRequestError",
  "setChallengeError",
  "setLogoError",
  "setSaved",
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "scripts/plain-language.baseline.json");

/** Copy-bearing `.ts` modules; every `.tsx` under src is read too. */
const COPY_MODULES = [
  "src/accounting/money-contracts.ts",
  "src/admin/automation-outcome.ts",
  "src/capabilities/capability-copy.ts",
  "src/components/ai/words.ts",
  "src/field/field-contracts.ts",
  "src/field/field-formatting.ts",
  "src/field/fleet-contracts.ts",
  "src/inventory/inventory-contracts.ts",
  "src/lib/plain-error.ts",
  "src/lib/roles.ts",
  "src/now/decision-presentation.ts",
  "src/owner/owner-now-utils.ts",
  "src/owner/owner-stop-copy.ts",
  "src/people/authority-contracts.ts",
  "src/pipeline/pipeline-board-model.ts",
  "src/production/production-gate-clearance-contracts.ts",
  "src/production/gates/gate-copy.ts",
  "src/production/gates/gate-time.ts",
  "src/public-estimate/public-estimate-request.ts",
  "src/schema-forms/schema-card-presentation.ts",
  "src/service/service-presentation.ts",
  "src/storage/outbox-failure.ts",
];
const NOT_SURFACES = [/\.test\./, /\.family\./, /^src\/test\//, /fixture/, /-test-harness\./];
/**
 * The one module allowed to read an error's own message: `messageFor` decides there whether the
 * words were written for people. Every other file is held to the raw-error-text rule, and this one
 * is still read for every other rule (its fallback sentence is copy like any other).
 */
const ERROR_TEXT_CHOKEPOINT = "src/lib/plain-error.ts";

function surfaceFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".tsx") ? [path] : [];
    });
  return [...walk("src"), ...COPY_MODULES]
    .filter((path) => !NOT_SURFACES.some((pattern) => pattern.test(path)))
    .sort();
}

/**
 * Every other `.ts` module under src is read for one thing only: the words a `new PlainError(...)`
 * carries. `messageFor` shows those verbatim, so they are copy wherever they are thrown, even in
 * storage and transport code that is otherwise not a screen.
 */
function plainErrorFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
  return walk("src")
    .filter((path) => !NOT_SURFACES.some((pattern) => pattern.test(path)))
    .filter((path) => !COPY_MODULES.includes(path))
    .filter((path) => readFileSync(resolve(root, path), "utf8").includes("new PlainError("))
    .sort();
}

interface AstNode {
  type: string;
  loc?: { start: { line: number }; end: { line: number } } | null;
  [key: string]: unknown;
}
interface Hit {
  rule: RuleId;
  line: number;
  text: string;
  found: string;
  suggest?: string;
}
interface Escape {
  line: number;
  rule: string;
  reason: string;
  used: boolean;
}
interface Analysis {
  hits: Hit[];
  soft: { term: string; line: number }[];
  escapes: Escape[];
}
interface Context {
  details: boolean;
  code: boolean;
  refTag: boolean;
}

const VISITOR_KEYS = types.VISITOR_KEYS as Record<string, readonly string[]>;
const node = (value: unknown): AstNode | null =>
  value && typeof value === "object" && typeof (value as AstNode).type === "string"
    ? (value as AstNode)
    : null;
const lineOf = (value: AstNode) => value.loc?.start.line ?? 0;
const nameOf = (value: unknown): string | null => {
  const named = node(value);
  if (!named) return null;
  if (named.type === "Identifier" || named.type === "JSXIdentifier") return named.name as string;
  if (named.type === "StringLiteral") return named.value as string;
  if (named.type === "JSXNamespacedName") return `${nameOf(named.namespace)}:${nameOf(named.name)}`;
  if (named.type === "JSXMemberExpression")
    return `${nameOf(named.object)}.${nameOf(named.property)}`;
  return null;
};

/** Copy is text with at least two letters; outside JSX text it must also look like words. */
function isCopy(text: string, strict: boolean): boolean {
  if ((text.match(/[A-Za-z]/g)?.length ?? 0) < 2) return false;
  if (!strict) return true;
  if (/^(?:https?:|mailto:|tel:|\/|\.\.?\/|#)/.test(text)) return false;
  if (!/\s/.test(text)) return /^[A-Z][A-Za-z0-9'’-]*[.!?]?$/.test(text);
  const looksLikeClasses =
    !/[A-Z]/.test(text) &&
    !/[.?!,;'’"]/.test(text) &&
    text.split(/\s+/).some((token) => /[-:[]/.test(token));
  return !looksLikeClasses;
}

/** Strings an expression can show, each branch on its own; templates read `{x}` for a value. */
function stringsOf(expression: unknown): { text: string; line: number }[] {
  const value = node(expression);
  if (!value) return [];
  switch (value.type) {
    case "StringLiteral":
      return [{ text: value.value as string, line: lineOf(value) }];
    case "TemplateLiteral":
      return [{ text: templateText(value), line: lineOf(value) }];
    case "ConditionalExpression":
      return [...stringsOf(value.consequent), ...stringsOf(value.alternate)];
    case "LogicalExpression":
      return [...stringsOf(value.left), ...stringsOf(value.right)];
    case "BinaryExpression":
      return value.operator === "+" &&
        (stringsOf(value.left).length || stringsOf(value.right).length)
        ? [{ text: concatText(value), line: lineOf(value) }]
        : [];
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return stringsOf(value.expression);
    default:
      return [];
  }
}

function templateText(template: AstNode): string {
  const quasis = template.quasis as { value: { cooked: string | null; raw: string } }[];
  return quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("{x}");
}

function concatText(value: unknown): string {
  const part = node(value);
  if (!part) return "{x}";
  if (part.type === "StringLiteral") return part.value as string;
  if (part.type === "TemplateLiteral") return templateText(part);
  if (part.type === "BinaryExpression" && part.operator === "+")
    return concatText(part.left) + concatText(part.right);
  return "{x}";
}

/** Does this rendered expression print an id, reference, code, digest or hash? */
function printsCode(expression: unknown): boolean {
  const value = node(expression);
  if (!value) return false;
  switch (value.type) {
    case "Identifier":
      return CODE_NAME.test(value.name as string);
    case "MemberExpression":
    case "OptionalMemberExpression":
      return !value.computed && CODE_NAME.test(nameOf(value.property) ?? "");
    case "LogicalExpression":
      return printsCode(value.left) || printsCode(value.right);
    case "ConditionalExpression":
      return printsCode(value.consequent) || printsCode(value.alternate);
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "ParenthesizedExpression":
      return printsCode(value.expression);
    default:
      return false;
  }
}

/** Is this the object of `.message` an error (by the names this codebase gives errors)? */
function isErrorObject(expression: unknown): boolean {
  const value = node(expression);
  if (!value) return false;
  switch (value.type) {
    case "Identifier":
      return ERROR_NAME.test(value.name as string);
    case "MemberExpression":
    case "OptionalMemberExpression":
      return !value.computed && ERROR_NAME.test(nameOf(value.property) ?? "");
    case "LogicalExpression":
      return isErrorObject(value.left) || isErrorObject(value.right);
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "ParenthesizedExpression":
      return isErrorObject(value.expression);
    default:
      return false;
  }
}

/** `.replace("_", " ")`, `.replaceAll("_", " ")`, `.replace(/[._-]+/g, " ")` and the like. */
function swapsUnderscores(call: AstNode): boolean {
  const callee = node(call.callee);
  const method = callee && !callee.computed ? nameOf(callee.property) : null;
  if (method !== "replace" && method !== "replaceAll") return false;
  const [from, to] = (call.arguments as unknown[]).map(node);
  if (!from || !to || to.type !== "StringLiteral" || to.value !== " ") return false;
  if (from.type === "StringLiteral") return from.value === "_";
  if (from.type !== "RegExpLiteral") return false;
  const pattern = (from.pattern as string).replace(/[[\]+*\\]/g, "");
  return pattern.includes("_") && /^[_.-]+$/.test(pattern);
}

export function analyse(
  path: string,
  source: string,
  options: { plainErrorsOnly?: boolean } = {},
): Analysis {
  const ast = parseSync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: { plugins: path.endsWith(".ts") ? ["typescript"] : ["typescript", "jsx"] },
  }) as unknown as AstNode & { comments?: { value: string; loc: { end: { line: number } } }[] };
  const copies: { text: string; line: number }[] = [];
  const hits: Hit[] = [];
  const taken = new WeakSet<object>();

  const escapes: Escape[] = (ast.comments ?? []).flatMap((comment) => {
    const match = comment.value.match(/plain-language-allow:\s*([a-z-]*)\s*(?:-\s*(.*))?$/m);
    if (!match) return [];
    return [
      {
        line: comment.loc.end.line,
        rule: match[1] ?? "",
        reason: (match[2] ?? "").trim(),
        used: false,
      },
    ];
  });

  const copy = (entries: { text: string; line: number }[], context: Context, strict: boolean) => {
    if (context.details || context.code) return;
    for (const entry of entries) {
      const text = entry.text.replace(/\s+/g, " ").trim();
      if (isCopy(text, strict)) copies.push({ text, line: entry.line });
    }
  };
  const take = (expression: unknown) => {
    const found = stringsOf(expression);
    const value = node(expression);
    if (value) taken.add(value);
    return found;
  };

  const walkJsxChildren = (element: AstNode, context: Context) => {
    let run = { text: "", line: 0 };
    const flush = () => {
      copy([run], context, false);
      run = { text: "", line: 0 };
    };
    for (const childValue of element.children as unknown[]) {
      const child = node(childValue);
      if (!child) continue;
      if (child.type === "JSXText") {
        const value = child.value as string;
        if (!run.line && value.trim())
          run.line = lineOf(child) + (value.slice(0, value.search(/\S/)).match(/\n/g)?.length ?? 0);
        run.text += value;
        continue;
      }
      if (child.type !== "JSXExpressionContainer") {
        flush();
        continue;
      }
      const expression = node(child.expression);
      if (!expression || expression.type === "JSXEmptyExpression") continue;
      if (expression.type === "StringLiteral" || expression.type === "TemplateLiteral") {
        if (!run.line) run.line = lineOf(child);
        run.text +=
          expression.type === "StringLiteral"
            ? (expression.value as string)
            : templateText(expression);
        taken.add(expression);
        continue;
      }
      if (!run.line) run.line = lineOf(child);
      run.text += "{x}";
      copy(take(expression), context, false);
      if (!context.details && !context.code && !context.refTag && printsCode(expression))
        hits.push({
          rule: "unlabelled-code",
          line: lineOf(child),
          text: source.slice(
            (child as unknown as { start: number }).start,
            (child as unknown as { end: number }).end,
          ),
          found: "a code with no plain label",
        });
    }
    flush();
  };

  const walk = (value: unknown, context: Context): void => {
    const current = node(value);
    if (!current) return;
    let next = context;

    if (options.plainErrorsOnly) {
      if (current.type === "NewExpression" && nameOf(current.callee) === "PlainError")
        copy(take((current.arguments as unknown[])[0]), context, true);
    } else if (current.type === "JSXElement") {
      const opening = current.openingElement as AstNode;
      const element = nameOf(opening.name) ?? "";
      const attributes = (opening.attributes as unknown[]).map(node).filter(Boolean) as AstNode[];
      const systemDetails =
        element === "SystemDetails" ||
        (element === "details" &&
          attributes.some((attribute) => nameOf(attribute.name) === "data-system-details"));
      for (const attribute of attributes) {
        if (attribute.type !== "JSXAttribute") continue;
        const name = nameOf(attribute.name) ?? "";
        if (SKIP_ATTRS.has(name) || name.startsWith("data-") || /^on[A-Z]/.test(name)) continue;
        const readable = COPY_ATTRS.has(name);
        if (!readable && !COPY_COMPONENTS.has(element)) continue;
        const attributeValue = node(attribute.value);
        if (!attributeValue) continue;
        const strings =
          attributeValue.type === "JSXExpressionContainer"
            ? take(attributeValue.expression)
            : take(attributeValue);
        copy(strings, context, !readable);
      }
      next = {
        details: context.details || systemDetails,
        code: context.code || element === "code" || element === "kbd",
        refTag: context.refTag || element === "RefTag",
      };
      walkJsxChildren(current, next);
    } else if (current.type === "JSXFragment") {
      walkJsxChildren(current, context);
    } else if (current.type === "ObjectProperty" && !current.computed) {
      const key = nameOf(current.key) ?? "";
      const strings =
        node(current.value) && !taken.has(node(current.value)!) ? take(current.value) : [];
      if (COPY_KEYS.has(key)) copy(strings, context, true);
      else
        copy(
          strings.filter((entry) => /^[A-Z][^]*\s\S/.test(entry.text)),
          context,
          true,
        );
    } else if (current.type === "CallExpression" || current.type === "NewExpression") {
      const callee = nameOf(current.callee);
      const [first] = current.arguments as unknown[];
      if (callee && (SETTERS.has(callee) || callee === "PlainError"))
        copy(take(first), context, true);
      if (current.type === "CallExpression" && !context.details && swapsUnderscores(current))
        hits.push({
          rule: "machine-name",
          line: lineOf(current),
          text: source.slice(
            (current as unknown as { start: number }).start,
            (current as unknown as { end: number }).end,
          ),
          found: "underscores turned into spaces",
        });
    } else if (current.type === "ReturnStatement") {
      const argument = node(current.argument);
      if (argument && !taken.has(argument)) copy(take(argument), context, true);
    } else if (current.type === "ArrowFunctionExpression") {
      const body = node(current.body);
      if (body && body.type !== "BlockStatement" && !taken.has(body))
        copy(take(body), context, true);
    } else if (current.type === "VariableDeclarator") {
      const init = node(current.init);
      if (init && !taken.has(init))
        copy(
          take(init).filter((entry) => /^[A-Z][^]*\s\S/.test(entry.text)),
          context,
          true,
        );
    } else if (
      (current.type === "MemberExpression" || current.type === "OptionalMemberExpression") &&
      !current.computed &&
      nameOf(current.property) === "message" &&
      !context.details &&
      path !== ERROR_TEXT_CHOKEPOINT &&
      isErrorObject(current.object)
    ) {
      hits.push({
        rule: "raw-error-text",
        line: lineOf(current),
        text: source.slice(
          (current as unknown as { start: number }).start,
          (current as unknown as { end: number }).end,
        ),
        found: "an error's own message",
      });
    }

    for (const key of VISITOR_KEYS[current.type] ?? []) {
      const child = current[key];
      if (Array.isArray(child)) for (const item of child) walk(item, next);
      else walk(child, next);
    }
  };
  walk(ast.program, { details: false, code: false, refTag: false });

  const soft: Analysis["soft"] = [];
  for (const { text, line } of copies) {
    for (const banned of BANNED) {
      const match = text.match(banned.pattern);
      if (match) {
        hits.push({
          rule: "banned-term",
          line,
          text,
          found: `"${match[0]}"`,
          suggest: banned.suggest,
        });
        break;
      }
    }
    for (const agent of AGENTS) {
      const match = text.match(agent.pattern);
      if (match) {
        hits.push({
          rule: "agent-name",
          line,
          text,
          found: `"${match[0]}"`,
          suggest: agent.suggest,
        });
        break;
      }
    }
    for (const literal of text.matchAll(CODE_LITERAL)) {
      if (CODE_LABEL.test(text.slice(0, literal.index))) continue;
      hits.push({
        rule: "unlabelled-code",
        line,
        text,
        found: `"${literal[0]}" with no plain label`,
      });
    }
    for (const word of SOFT) if (word.pattern.test(text)) soft.push({ term: word.term, line });
  }

  const kept = hits.filter((hit) => {
    const escape = escapes.find(
      (candidate) =>
        candidate.rule === hit.rule &&
        (candidate.line === hit.line - 1 || candidate.line === hit.line),
    );
    if (escape) escape.used = true;
    return !escape;
  });
  return { hits: kept, soft, escapes };
}

/** `index.html` text and the install prompt's name and description are copy too. */
function shellAnalyses(): Record<string, Analysis> {
  const html = readFileSync(resolve(root, "index.html"), "utf8")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n");
  const htmlCopy = html.flatMap((line, index) => {
    const description = line.match(/<meta name="description" content="([^"]*)"/)?.[1];
    const text = line.replace(/<[^>]*>/g, " ").trim();
    return [description, text]
      .filter((entry): entry is string => Boolean(entry) && /[A-Za-z]{2}/.test(entry ?? ""))
      .map((entry) => `${"\n".repeat(index)}<>{${JSON.stringify(entry)}}</>`);
  });
  const vite = readFileSync(resolve(root, "vite.config.ts"), "utf8");
  const manifest = [...vite.matchAll(/^\s*(name|short_name|description): ("[^"]*"),$/gm)].map(
    (match) => {
      const line = vite.slice(0, match.index).split("\n").length;
      return `${"\n".repeat(line - 1)}<>{${match[2]}}</>`;
    },
  );
  const fromLines = (lines: string[], path: string) => {
    const merged: Analysis = { hits: [], soft: [], escapes: [] };
    for (const snippet of lines) {
      const part = analyse(`${path}.tsx`, snippet);
      merged.hits.push(...part.hits);
      merged.soft.push(...part.soft);
    }
    return merged;
  };
  return {
    "index.html": fromLines(htmlCopy, "index"),
    "vite.config.ts": fromLines(manifest, "vite"),
  };
}

type Counts = Record<string, Partial<Record<CountedRule, number>>>;

const files = surfaceFiles();
const plainErrorOnly = plainErrorFiles();
const analyses: Record<string, Analysis> = {
  ...Object.fromEntries(
    files.map((path) => [path, analyse(path, readFileSync(resolve(root, path), "utf8"))]),
  ),
  ...Object.fromEntries(
    plainErrorOnly.map((path) => [
      path,
      analyse(path, readFileSync(resolve(root, path), "utf8"), { plainErrorsOnly: true }),
    ]),
  ),
  ...shellAnalyses(),
};

function countsOf(reports: Record<string, Analysis>): Counts {
  const counts: Counts = {};
  for (const [path, report] of Object.entries(reports)) {
    const entry: Partial<Record<CountedRule, number>> = {};
    for (const hit of report.hits) entry[hit.rule] = (entry[hit.rule] ?? 0) + 1;
    if (report.escapes.length) entry["allow-escape"] = report.escapes.length;
    if (Object.keys(entry).length) counts[path] = sortKeys(entry);
  }
  return sortKeys(counts);
}

function sortKeys<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ) as T;
}

const found = countsOf(analyses);
const recorded: Counts = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Counts)
  : {};

// Shrink-only: a fixing change lowers counts in the same diff; nothing here raises one. With no
// baseline file at all (day one), today's counts become the baseline.
if (process.env.UPDATE_PLAIN_BASELINE) {
  const bootstrap = !existsSync(baselinePath);
  const next: Counts = {};
  for (const [path, rules] of Object.entries(bootstrap ? found : recorded)) {
    const kept: Partial<Record<CountedRule, number>> = {};
    for (const rule of COUNTED) {
      const allowed = rules[rule] ?? 0;
      const now = found[path]?.[rule] ?? 0;
      const value = Math.min(allowed, now);
      if (value > 0) kept[rule] = value;
    }
    if (Object.keys(kept).length) next[path] = kept;
  }
  writeFileSync(baselinePath, `${JSON.stringify(sortKeys(next), null, 2)}\n`);
  Object.keys(recorded).forEach((path) => delete recorded[path]);
  Object.assign(recorded, next);
}

const fixHint = (rule: CountedRule) =>
  `How to fix: ${HOW_TO_FIX[rule]}\nA true exception takes \`// plain-language-allow: ${rule} - <reason>\` on the line above it.`;

describe("IronWrap plain-language family", () => {
  it("reads every screen and copy module, and no tests, fixtures or transport", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const path of [
      "src/components/ui/ref-tag.tsx",
      "src/components/ai/words.ts",
      "src/field/today-page.tsx",
      "src/storage/outbox-failure.ts",
      "src/lib/plain-error.ts",
    ])
      expect(files).toContain(path);
    for (const path of [
      "src/lib/api.ts",
      "src/admin/admin-test-harness.tsx",
      "src/components/ui/primitives.test.tsx",
      "src/storage/outbox.ts",
    ])
      expect(files).not.toContain(path);
    // Transport and storage code is still read for the words a PlainError carries.
    expect(plainErrorOnly).toContain("src/storage/outbox.ts");
    expect(plainErrorOnly).not.toContain("src/lib/plain-error.ts");
    expect(plainErrorOnly.filter((path) => files.includes(path))).toEqual([]);
  });

  it("matches each term on its examples and on nothing near them", () => {
    for (const entry of [...BANNED, ...AGENTS, ...SOFT]) {
      for (const sample of entry.hits) expect(sample, entry.term).toMatch(entry.pattern);
      for (const sample of entry.misses) expect(sample, entry.term).not.toMatch(entry.pattern);
    }
  });

  it("finds copy, codes, raw errors and machine names where the gate means them", () => {
    const sample = `
      export function Sample({ error, item, offline, key }) {
        return (
          <section>
            <h2>Tenant settings</h2>
            <Notice tone="warning" title="Payload rejected">Saved on this phone.</Notice>
            <p>{item.lot_code}</p>
            <RefTag kind="lot" id={item.lot_code} />
            <p>{error.message}</p>
            <p>{offline ? "Outbox waiting" : "Sent"}</p>
            <details><summary>More</summary><p>Digest abc</p></details>
            <SystemDetails><p>SHA-256 {item.digest}</p><p>{item.request_id}</p></SystemDetails>
            <p className="tenant-row grant-cell">plain</p>
            <p>{key.replaceAll("_", " ")}</p>
            <p>Current request v{item.version}</p>
            <p>Coil PMS-2231 and PMS-2232</p>
            <p>Answered by Hermes</p>
            {/* plain-language-allow: banned-term - a sample exception */}
            <p>Grant access</p>
            <code>tenant_id</code>
            <p>Ask the Assistant</p>
            <p>The AI drafted it</p>
            <p>Drafted by AI estimator for the AI team. Ask IronWrap.</p>
            <p>Delegation A3</p>
            <p>Run ID</p>
            <p>Request hash</p>
            <SystemDetails><p>Run ID {item.run_id}, class A2, request hash</p></SystemDetails>
          </section>
        );
      }
    `;
    const report = analyse("sample.tsx", sample);
    const summary = report.hits.map((hit) => `${hit.rule} ${hit.found}`).sort();
    expect(summary).toEqual(
      [
        'agent-name "Hermes"',
        'agent-name "Assistant"',
        'agent-name "AI"',
        'banned-term "A3"',
        'banned-term "Run ID"',
        'banned-term "hash"',
        'banned-term "Digest"',
        'banned-term "Outbox"',
        'banned-term "Payload"',
        'banned-term "Tenant"',
        'banned-term "v{x}"',
        "machine-name underscores turned into spaces",
        "raw-error-text an error's own message",
        'unlabelled-code "PMS-2232" with no plain label',
        "unlabelled-code a code with no plain label",
      ].sort(),
    );
    expect(report.escapes).toEqual([
      { line: 18, rule: "banned-term", reason: "a sample exception", used: true },
    ]);
  });

  it("reads only the words a PlainError carries in a module that is not a screen", () => {
    const source = `
      export function check(value) {
        if (!value) throw new PlainError("The outbox is full.");
        if (value.bad) throw new Error("Tenant payload rejected");
        return { label: "Digest" };
      }
    `;
    const report = analyse("src/storage/some-module.ts", source, { plainErrorsOnly: true });
    expect(report.hits.map((hit) => `${hit.rule} ${hit.found}`)).toEqual(['banned-term "outbox"']);
    // Read as a copy module, the same file would count its other strings too.
    expect(analyse("src/storage/some-module.ts", source).hits.length).toBeGreaterThan(1);
  });

  it("lets only the chokepoint read an error's message, and still reads it for every other rule", () => {
    const read = "export const words = (error) => error.message;";
    expect(analyse("src/field/some-page.tsx", read).hits.map((hit) => hit.rule)).toEqual([
      "raw-error-text",
    ]);
    expect(analyse(ERROR_TEXT_CHOKEPOINT, read).hits).toEqual([]);

    const fallback = 'export const PLAIN_FALLBACK = "Your outbox went wrong.";';
    expect(analyse(ERROR_TEXT_CHOKEPOINT, fallback).hits.map((hit) => hit.rule)).toEqual([
      "banned-term",
    ]);
  });

  for (const rule of COUNTED) {
    it(`does not let ${rule} grow past its baseline`, () => {
      const problems: string[] = [];
      for (const [path, rules] of Object.entries(found)) {
        const now = rules[rule] ?? 0;
        const allowed = recorded[path]?.[rule] ?? 0;
        if (now <= allowed) continue;
        problems.push(`${path}: ${now} found, the baseline allows ${allowed}`);
        const report = analyses[path]!;
        if (rule === "allow-escape") {
          for (const escape of report.escapes)
            problems.push(`  ${path}:${escape.line}  ${escape.rule} - ${escape.reason}`);
          continue;
        }
        for (const hit of report.hits.filter((entry) => entry.rule === rule))
          problems.push(
            `  ${path}:${hit.line}  ${hit.found} in ${JSON.stringify(hit.text.slice(0, 140))}${
              hit.suggest ? ` -> ${hit.suggest}` : ""
            }`,
          );
      }
      expect(
        problems,
        `Plain-language guard (design/ZERO-LEARNING-GATE.md, Z2): ${rule} went up.\n${fixHint(rule)}`,
      ).toEqual([]);
    });
  }

  it("keeps the baseline tight, so a fix shrinks it in the same change", () => {
    const stale: string[] = [];
    for (const [path, rules] of Object.entries(recorded)) {
      for (const rule of COUNTED) {
        const allowed = rules[rule] ?? 0;
        const now = found[path]?.[rule] ?? 0;
        if (now < allowed) stale.push(`${path} ${rule}: ${allowed} recorded, ${now} found`);
      }
    }
    expect(
      stale,
      "Fewer hits than the baseline records. Good: lock it in with\n" +
        "UPDATE_PLAIN_BASELINE=1 npx vitest run scripts/plain-language.family.test.ts\n" +
        "and commit app/scripts/plain-language.baseline.json with the fix.",
    ).toEqual([]);
  });

  it("accepts only escapes that name a rule, give a reason and still excuse something", () => {
    const wrong: string[] = [];
    for (const [path, report] of Object.entries(analyses))
      for (const escape of report.escapes) {
        if (!RULES.includes(escape.rule as RuleId) || !escape.reason)
          wrong.push(`${path}:${escape.line} needs "plain-language-allow: <rule> - <reason>"`);
        else if (!escape.used)
          wrong.push(`${path}:${escape.line} excuses nothing on the next line; delete it`);
      }
    expect(wrong).toEqual([]);
  });

  it("reports soft words without failing", () => {
    const totals = new Map<string, number>();
    const perFile: string[] = [];
    for (const [path, report] of Object.entries(analyses)) {
      const counts = new Map<string, number>();
      for (const { term: word } of report.soft) counts.set(word, (counts.get(word) ?? 0) + 1);
      for (const [word, count] of counts) totals.set(word, (totals.get(word) ?? 0) + count);
      if (counts.size)
        perFile.push(
          `  ${path}: ${[...counts].map(([word, count]) => `${word} ${count}`).join(", ")}`,
        );
    }
    console.info(
      `Plain-language soft words (reported, not failing): ${[...totals]
        .sort((left, right) => right[1] - left[1])
        .map(([word, count]) => `${word} ${count}`)
        .join(", ")}${process.env.PLAIN_LANGUAGE_REPORT ? `\n${perFile.join("\n")}` : ""}`,
    );
    expect(totals.size).toBeGreaterThan(0);
  });
});
