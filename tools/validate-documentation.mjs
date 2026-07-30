#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(root, "docs/manifest.json");
const allowedClasses = new Set(["canonical", "runbook", "component", "runtime", "developer"]);
const documentExtensions = new Set([
  ".md",
  ".mdx",
  ".pdf",
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
]);
const forbiddenBinaryExtensions = new Set(
  [...documentExtensions].filter((extension) => ![".md", ".mdx"].includes(extension)),
);
const forbiddenPaths = [
  /^docs\/archive\//,
  /^final-spec-pack\//,
  /^task1-spec\//,
  /^output\//,
  /^samples\//,
  /(^|\/)(DELIVERY-PLAN|PRODUCT|SETUP-CHECKLIST)\.md$/,
  /(^|\/)PRODUCTION-READINESS-(AUDIT|RESOLUTION)-\d{4}-\d{2}-\d{2}\.md$/,
];
const absoluteWorkstationPath =
  /(?:file:\/\/\/|\/Users\/[^/\s]+\/|[A-Za-z]:\\Users\\)/;

const failures = [];
const fail = (message) => failures.push(message);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = manifest.documents ?? [];
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString()
  .split("\0")
  .filter(Boolean);
const trackedSet = new Set(tracked);
const trackedDocuments = tracked.filter((path) => documentExtensions.has(extname(path).toLowerCase()));

if (manifest.schema_version !== 1) fail("docs/manifest.json: schema_version must be 1");
if (!Array.isArray(manifest.documents)) fail("docs/manifest.json: documents must be an array");

const paths = entries.map((entry) => entry.path);
const pathSet = new Set(paths);
if (pathSet.size !== paths.length) fail("docs/manifest.json: document paths must be unique");
if (paths.join("\n") !== [...paths].sort().join("\n")) {
  fail("docs/manifest.json: document entries must be sorted by path");
}

for (const entry of entries) {
  if (!entry || typeof entry.path !== "string") {
    fail("docs/manifest.json: every entry needs a path");
    continue;
  }
  if (!allowedClasses.has(entry.class)) {
    fail(`${entry.path}: unknown document class ${JSON.stringify(entry.class)}`);
  }
  if (!trackedSet.has(entry.path)) fail(`${entry.path}: manifest entry is not a tracked file`);
  if (!Array.isArray(entry.authority)) fail(`${entry.path}: authority must be an array`);
}

for (const path of trackedDocuments) {
  if (!pathSet.has(path)) fail(`${path}: tracked document is missing from docs/manifest.json`);
  if (forbiddenBinaryExtensions.has(extname(path).toLowerCase())) {
    fail(`${path}: binary office/PDF documents may not be tracked`);
  }
  if (forbiddenPaths.some((pattern) => pattern.test(path))) {
    fail(`${path}: forbidden legacy, generated, archive, or customer-evidence path`);
  }
}

for (const path of paths) {
  if (!trackedDocuments.includes(path)) fail(`${path}: manifest path is not a tracked document`);
}

const canonicalPaths = new Set(
  entries.filter((entry) => entry.class === "canonical").map((entry) => entry.path),
);
for (const entry of entries) {
  if (entry.class === "canonical") {
    if (entry.authority.length !== 0) fail(`${entry.path}: canonical authority must be empty`);
    continue;
  }
  if (entry.authority.length === 0) fail(`${entry.path}: non-canonical document needs authority`);
  for (const authority of entry.authority) {
    if (!canonicalPaths.has(authority)) {
      fail(`${entry.path}: authority ${authority} is not a registered canonical document`);
    }
  }
}

for (const entry of entries) {
  if (!existsSync(resolve(root, entry.path))) continue;
  const content = readFileSync(resolve(root, entry.path), "utf8");

  if (absoluteWorkstationPath.test(content)) {
    fail(`${entry.path}: contains an absolute workstation path`);
  }

  if (entry.class === "canonical") {
    if (!/^Status:\s+\S+/m.test(content)) fail(`${entry.path}: missing Status metadata`);
    if (!/^Owner:\s+\S+/m.test(content)) fail(`${entry.path}: missing Owner metadata`);
    if (!/^Last (?:verified|source verification):\s+\d{4}-\d{2}-\d{2}/m.test(content)) {
      fail(`${entry.path}: missing dated verification metadata`);
    }
    if (!/^(?:Review trigger|Immediate review trigger):\s+\S+/m.test(content)) {
      fail(`${entry.path}: missing review-trigger metadata`);
    }
  }

  const links = content.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g);
  for (const match of links) {
    let destination = match[1].trim();
    if (destination.startsWith("<") && destination.endsWith(">")) {
      destination = destination.slice(1, -1);
    } else {
      destination = destination.split(/\s+["']/)[0];
    }
    if (
      !destination ||
      destination.startsWith("#") ||
      destination.startsWith("/") ||
      /^(?:https?:|mailto:|tel:|data:)/i.test(destination)
    ) {
      continue;
    }
    destination = destination.split("#", 1)[0].split("?", 1)[0];
    try {
      destination = decodeURIComponent(destination);
    } catch {
      fail(`${entry.path}: invalid URL encoding in link ${match[1]}`);
      continue;
    }
    const target = resolve(root, dirname(entry.path), destination);
    if (!existsSync(target)) {
      fail(`${entry.path}: broken internal link ${match[1]}`);
    } else if (!statSync(target).isFile() && !statSync(target).isDirectory()) {
      fail(`${entry.path}: internal link is not a file or directory ${match[1]}`);
    }
  }
}

const compliance = readFileSync(resolve(root, "docs/COMPLIANCE-REGISTER.md"), "utf8");
const nextReview = compliance.match(/^Next scheduled review:\s+(\d{4}-\d{2}-\d{2})/m)?.[1];
if (!nextReview) {
  fail("docs/COMPLIANCE-REGISTER.md: missing Next scheduled review");
} else if (nextReview < new Date().toISOString().slice(0, 10)) {
  fail(`docs/COMPLIANCE-REGISTER.md: scheduled review expired on ${nextReview}`);
}

if (failures.length) {
  console.error(`documentation validation failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`ok ${trackedDocuments.length} registered documents validated`);
