// Privacy layer for the history evaluation. Real records stay in git-ignored output/ and the qa D1;
// before any record reaches a prompt it is pseudonymised here:
// - personal identifiers become stable letter-only tokens (the salt and mapping stay in output/);
// - addresses are reduced to a municipality from a fixed list and a province code;
// - free text is normalised, scrubbed of every known identifier in the export and of detectable
//   patterns, and dropped unless every remaining word is ordinary (see `looksReliable`);
// - `createGuard` is the guard. A text field that fails it is dropped; any other field that fails
//   it is a bug, and the caller stops.

import { createHmac } from "node:crypto";

import { ACRONYMS, BASE_WORDS, DATE_CUES, DATE_HOMONYMS, NAME_HOMONYMS, PERSON_ACTIONS, PERSON_AUXILIARIES, PERSON_VERBS, SURNAME_HOMONYMS } from "./privacy-words.mjs";

// Matching runs on normalised text: NFKD with diacritics removed, one apostrophe, one dash.
export function normaliseText(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/[   ]/g, " ");
}

// Street suffixes. These count in any case after one to three name words ("123 oak street nw").
const STREET = "Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Crescent|Cres|Lane|Ln|Trail|Grove|Bay|Cove|Parkway|Pkwy|Highway|Hwy|Mews|Crest|Wynd|Ct|Circle|Cir";
// These also name ordinary things ("24 sq ft", "4 layers in the park"), so they count only capitalised.
const STREET_CAPITALISED = "Court|Way|Close|Cl|Place|Pl|Terrace|Gate|Green|Heights|Hts|Landing|Link|Manor|Park|Point|Rise|View|Square|Sq|Common|Commons|Gardens|Glen|Bend|Row|Run|Walk|Hill|Hills|Meadows|Estates|Village|Woods|Ridge";
// Words that never begin a street name: quantities and units ("2 hours drive", "3 crew on the road").
const NOT_STREET =
  "the|a|an|on|off|in|at|to|of|for|per|and|or|by|from|with|into|onto|about|around|near|car|cars|big|small|large|extra|our|my|his|her|their|days?|hours?|hrs?|weeks?|mins?|minutes?|months?|years?|crews?|men|guys|people|layers?|squares?|sq|ft|feet|bundles?|sheets?|panels?|pieces?|pcs|rolls?|boxes|lf|trucks?|loads?|trips?|times?|more|other";
const QUADRANT = "(?:\\s+(?:NW|NE|SW|SE|N|S|E|W)\\b)?";
// Rural parts: "RR 2, Site 4, Box 5", "Lot 4 Block 2 Plan 1234". Site, Comp, Lot, Block, and Plan
// count only in a run of two or more parts, so "on site 3 days" and "Lot 5 of materials" stay text.
// Spaces between parts are bounded, so no input makes the match slow.
const RURAL_PART = "(?:Site|Box|Comp|Lot|Block|Plan|R\\.?R\\.?)\\s{0,2}#?\\s{0,2}\\d+[A-Z]?";
const UNITS_AFTER = "(?!\\s*(?:(?:sq|ft|feet|sf|lf|mm|cm|in|squares?|bundles?|sheets?|pieces|pcs|lbs?|kg)\\b|[\"'x%]))";

const PATTERNS = {
  // Lengths are bounded (64 for the local part, as in RFC 5321), so a long run of letters stays fast.
  email: /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,253}\.\p{L}{2,63}|[\p{L}\p{N}._%+-]{1,64}\s{0,3}[[(]\s{0,3}at\s{0,3}[\])]\s{0,3}[\p{L}\p{N}.-]{1,253}\s{0,3}(?:[[(]\s{0,3}dot\s{0,3}[\])]|\.)\s{0,3}\p{L}{2,63}/giu,
  phone: new RegExp(
    `(?<![\\w-])(?:\\+?1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}(?:\\s*(?:x|ext\\.?)\\s*\\d{1,5})?(?![\\w-])` +
      `|(?<![\\w-])\\+\\d{1,3}(?:[\\s.-]?\\d{2,4}){3,5}(?![\\w-])` +
      `|(?<![\\w.-])[2-9]\\d{2}[\\s.-]\\d{4}(?![\\w.-])${UNITS_AFTER}`,
    "gi",
  ),
  postal_code: /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi,
  rural_address: new RegExp(
    `\\b${RURAL_PART}(?:\\s{0,3},?\\s{0,3}${RURAL_PART})+` +
      `|\\b(?:R\\.?R\\.?|Rural Route)\\s*#?\\s*\\d+|\\bP\\.?\\s*O\\.?\\s*Box\\s*#?\\s*\\d+|\\bBox\\s*#?\\s*\\d+` +
      `|\\b(?:Township|Twp\\.?|Range|Rge\\.?|Rng\\.?)\\s*(?:Road|Rd\\.?)\\s*\\d+[A-Z]?|\\b\\d{3,6}\\s+(?:Highway|Hwy\\.?)\\s*\\d+[A-Z]?`,
    "gi",
  ),
  // Edmonton-style "10234 82 Ave": the house number goes with the numbered street.
  numbered_street: /\b\d{3,6}\s*-?\s*\d{1,3}(?:st|nd|rd|th)?\s+(?:street|st|avenue|ave)\b/gi,
  street_address: new RegExp(
    `\\b\\d{1,6}[A-Za-z]?\\s+(?:(?!(?:${NOT_STREET})\\b)\\p{L}[\\p{L}'.-]*\\s+){1,3}(?:${STREET})\\b(?!\\s+(?:windows?|doors?|garages?|shops?|stalls?|units?)\\b)\\.?${QUADRANT}`,
    "giu",
  ),
  named_address: new RegExp(`\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Z][\\w'.-]*\\s+){0,3}(?:${STREET}|${STREET_CAPITALISED})\\b\\.?${QUADRANT}`, "g"),
  quadrant_address: /\b\d{3,6}\s+[A-Z][a-z]+\s+(?:NW|NE|SW|SE)\b/g,
  // Alberta land descriptions: quarter or LSD, section, township, range, meridian ("NE-14-52-26-W4").
  legal_land: /\b(?:(?:NE|NW|SE|SW|LSD)\s*[- ]?\s*)?\d{1,2}(?:-\d{1,3}){2,3}-?W\d\b/gi,
  coordinates: /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g,
  calendar_date:
    /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/gi,
  // Long digit runs: card, bank, and government numbers.
  account_number: /(?<![\w.])\d(?:[ -]?\d){8,18}(?![\w.])/g,
};
export const PII_PATTERNS = PATTERNS;

const fresh = (pattern) => new RegExp(pattern.source, pattern.flags);
const digits = (value) => String(value).replace(/\D/g, "");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phoneKey = (value) => digits(value).replace(/^1(?=\d{10}$)/, "");
const keyOf = (kind, value) => (kind === "phone" ? phoneKey(value) : normaliseText(value).trim().toLowerCase().replace(/\s+/g, " "));
const LETTERS = "abcdefghijklmnop";

/** Stable tokens for personal identifiers; letters only, so no token reads as a number. */
export function createPseudonymizer(salt) {
  if (typeof salt !== "string" || salt.length < 16) throw new Error("pseudonymizer salt must be a string of at least 16 characters");
  const originals = new Map();
  const token = (kind, value) => {
    if (value === null || value === undefined || String(value).trim() === "") return value ?? null;
    const hex = createHmac("sha256", salt).update(`${kind}:${keyOf(kind, value)}`).digest("hex").slice(0, 10);
    const id = `${kind}-${[...hex].map((char) => LETTERS[parseInt(char, 16)]).join("")}`;
    const seen = originals.get(id) ?? new Set();
    seen.add(String(value));
    originals.set(id, seen);
    return id;
  };
  return {
    token,
    /** Every original value that was tokenised, for the guard; written only to output/. */
    originals: () => [...originals].flatMap(([id, values]) => [...values].map((value) => ({ token: id, kind: id.split("-")[0], value }))),
  };
}

export const TOKEN = /\b(?:person|contact|company|email|phone|job|activity|address)-[a-p]{10}\b/g;
const PLACEHOLDER = new RegExp(`\\[(?:${Object.keys(PATTERNS).join("|")})\\]`, "g");
const BRANDS = /\bOwens\s+Corning\b/gi;

/**
 * The listed places that free text may keep as place names: every municipality none of whose words
 * is part of a name in the export, so a customer called Brooks or Hanna Manning is never read as
 * the town.
 */
export function safePlaces(municipalities = [], names = []) {
  const parts = new Set(names.flatMap((name) => (normaliseText(name).match(/\p{L}+/gu) ?? []).map((part) => part.toLowerCase())));
  return municipalities.filter((place) => !(normaliseText(place).match(/\p{L}+/gu) ?? []).some((part) => parts.has(part.toLowerCase())));
}

/** A pattern for listed place names (multi-word ones included), removed before the word check. */
export function placesPattern(places = []) {
  const names = [...places].map((place) => escape(normaliseText(place).trim()).replace(/\s+/g, "\\s+")).filter(Boolean);
  return names.length ? new RegExp(`(?<![\\p{L}])(?:${names.sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}])`, "giu") : null;
}

const sentences = (text) => text.split(/(?<=[.!?:;\n])\s+/);
const WORD = /(?<![\p{L}\p{N}])\p{L}[\p{L}'-]*|\d+/gu;
const wordKey = (word) => word.toLowerCase().replace(/'s?$/, "");
const isLower = (word) => word === word.toLowerCase();
// Lower-case words also count in a simple inflected form of a listed word ("reroofed", "leaks").
const STEMS = [[/s$/, ""], [/es$/, ""], [/ed$/, ""], [/ed$/, "e"], [/d$/, ""], [/ing$/, ""], [/ing$/, "e"], [/ly$/, ""], [/ers?$/, ""]];
// Introductions and greetings: the word after one is someone's name unless it is a listed word.
const INTRODUCTIONS =
  "hi|hello|hey|dear|thanks|thank you|regards|cheers|sincerely|my name is|this is|i am|i'm|spoke (?:to|with)|talked (?:to|with)|met with|called|texted|emailed|asked for|left (?:a )?(?:vm|voicemail|message) for";
const slot = (cues) => new RegExp(`\\b(?:${cues})\\b[,!:]?\\s+(\\p{L}[\\p{L}'-]*)`, "giu");
const NAME_SLOT = slot(INTRODUCTIONS);
// Wider slots for the export's vocabulary: a word ever seen after one of these is not learned.
const VOCABULARY_SLOT = slot(`${INTRODUCTIONS}|from|with|per|via|ask|asked|tell|told`);

const ordinary = (key, vocabulary) => BASE_WORDS.has(key) || Boolean(vocabulary?.has(key));
function ordinaryLower(key, vocabulary) {
  const parts = key.split("-").filter(Boolean);
  const one = (part) => ordinary(part, vocabulary) || STEMS.some(([end, add]) => end.test(part) && ordinary(part.replace(end, add), vocabulary));
  return one(key) || (parts.length > 1 && parts.every(one));
}
function ordinaryCapitalised(key) {
  const parts = key.split("-").filter(Boolean);
  const one = (part) => BASE_WORDS.has(part) && !NAME_HOMONYMS.has(part) && !SURNAME_HOMONYMS.has(part);
  return one(key) || (parts.length > 1 && parts.every(one));
}

// A capitalised word followed by what a person does: "Green said", "Price confirmed", "Wood is coming".
const actsAsPerson = (next, after) => PERSON_VERBS.has(wordKey(next)) || (PERSON_AUXILIARIES.has(wordKey(next)) && PERSON_ACTIONS.has(wordKey(after)));

/**
 * True when the text has at least one word and every word is ordinary once tokens, placeholders,
 * and safe places are removed. A lower-case word must be listed (`BASE_WORDS`) or in `vocabulary`
 * (built from the export by `buildVocabulary`). A capitalised or upper-case word must be an
 * acronym, or listed and not a name: a given-name homonym never counts, except "Will" and "May"
 * starting a sentence as verbs and month and season names next to a date word or a number; a
 * surname homonym counts only starting a sentence and not before what a person does. A greeting or
 * introduction followed by a word that is not listed fails it too.
 */
export function looksReliable(text, places = null, vocabulary = null) {
  let stripped = normaliseText(text).replace(fresh(TOKEN), " ").replace(fresh(PLACEHOLDER), " ").replace(fresh(BRANDS), " ");
  if (places) stripped = stripped.replace(fresh(places), " ");
  if (!/\p{L}/u.test(stripped)) return false;
  for (const sentence of sentences(stripped)) {
    const tokens = sentence.match(WORD) ?? [];
    for (let index = 0; index < tokens.length; index += 1) {
      const word = tokens[index];
      if (/^\d/.test(word)) continue;
      const key = wordKey(word);
      if (isLower(word)) {
        if (!ordinaryLower(key, vocabulary)) return false;
        continue;
      }
      if (ACRONYMS.has(word.replace(/'s$/i, "")) || ordinaryCapitalised(key)) continue;
      const next = tokens[index + 1] ?? "";
      const after = tokens[index + 2] ?? "";
      const previous = tokens[index - 1] ?? "";
      if (DATE_HOMONYMS.has(key) && (DATE_CUES.has(wordKey(previous)) || /^\d/.test(next))) continue;
      if (index === 0 && !actsAsPerson(next, after)) {
        if ((key === "will" || key === "may") && next && isLower(next) && ordinaryLower(wordKey(next), vocabulary)) continue;
        if (SURNAME_HOMONYMS.has(key) && BASE_WORDS.has(key)) continue;
      }
      return false;
    }
    for (const match of sentence.matchAll(fresh(NAME_SLOT))) {
      const key = wordKey(match[1]);
      if (!BASE_WORDS.has(key) || NAME_HOMONYMS.has(key)) return false;
    }
  }
  return true;
}

/**
 * Words used lower case in at least `minRecords` of the texts, for `looksReliable`. Left out: every
 * part of a known name, any word ever seen after a greeting, an introduction, or a word such as
 * "from", "with", or "tell", and any word written capitalised mid-sentence twice or more, or in more
 * than one use in twenty.
 */
export function buildVocabulary(texts, { names = [], minRecords = 20 } = {}) {
  const excluded = new Set(names.flatMap((name) => (normaliseText(name).match(WORD) ?? []).map(wordKey)));
  const records = new Map();
  const lower = new Map();
  const capitalised = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const text of texts) {
    if (typeof text !== "string" || text === "") continue;
    const clean = normaliseText(text);
    for (const match of clean.matchAll(fresh(VOCABULARY_SLOT))) excluded.add(wordKey(match[1]));
    const seen = new Set();
    for (const sentence of sentences(clean)) {
      (sentence.match(WORD) ?? []).forEach((word, index) => {
        if (/^\d/.test(word)) return;
        const key = wordKey(word);
        if (isLower(word)) {
          seen.add(key);
          bump(lower, key);
        } else if (index > 0) bump(capitalised, key);
      });
    }
    for (const key of seen) bump(records, key);
  }
  return new Set(
    [...records]
      .filter(([key, count]) => {
        const upper = capitalised.get(key) ?? 0;
        return count >= minRecords && key.length >= 2 && !excluded.has(key) && upper < 2 && upper * 20 <= lower.get(key);
      })
      .map(([key]) => key),
  );
}

// Known identifiers, matched word by word: each value is split into units (runs of letters and
// digits), compared without case or apostrophes, with a plural or possessive "s" on the last unit.
// A one-word name counts only where it stands capitalised, so "will" and "green" in ordinary
// sentences are not the names Will or Green. Phones are matched on their digits.
const UNIT = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const JOIN = /^[\s&.,@'-]{1,4}$/u;
const unitKey = (unit) => unit.toLowerCase().replace(/'/g, "");
const DIGIT_RUN = /\+?\d[\d\s().-]{5,}\d/g;

function createMatcher(entries) {
  const byFirst = new Map();
  const phones = new Map();
  for (const { kind, value, token } of entries) {
    if (value === undefined || value === null) continue;
    if (kind === "phone") {
      const key = phoneKey(value);
      if (key.length >= 7 && !phones.has(key)) phones.set(key, { kind, token });
      continue;
    }
    const units = (normaliseText(value).match(UNIT) ?? []).map(unitKey);
    if (units.length === 0 || !/\p{L}/u.test(units.join("")) || (units.length === 1 && units[0].length < 2)) continue;
    const entry = { kind, token, units, single: units.length === 1 && (kind === "person" || kind === "company") };
    if (!byFirst.has(units[0])) byFirst.set(units[0], []);
    byFirst.get(units[0]).push(entry);
  }
  const lengths = [...new Set([...phones.keys()].map((key) => key.length))];
  return (text) => {
    const units = [...text.matchAll(UNIT)].map((match) => ({ start: match.index, end: match.index + match[0].length, raw: match[0], key: unitKey(match[0]) }));
    const hits = [];
    for (let i = 0; i < units.length; i += 1) {
      const key = units[i].key;
      const candidates = [...(byFirst.get(key) ?? []), ...(key.endsWith("s") ? byFirst.get(key.slice(0, -1)) ?? [] : [])];
      let best = null;
      for (const entry of candidates) {
        const size = entry.units.length;
        if (i + size > units.length || (best && best.units.length >= size)) continue;
        const fits = entry.units.every((part, j) => {
          const unit = units[i + j];
          const same = unit.key === part || (j === size - 1 && unit.key === `${part}s`);
          return same && (j === 0 || JOIN.test(text.slice(units[i + j - 1].end, unit.start)));
        });
        if (fits && !(entry.single && !/^\p{Lu}/u.test(units[i].raw))) best = entry;
      }
      if (best) {
        hits.push({ start: units[i].start, end: units[i + best.units.length - 1].end, kind: best.kind, token: best.token });
        i += best.units.length - 1;
      }
    }
    for (const match of text.matchAll(DIGIT_RUN)) {
      const run = phoneKey(match[0]);
      let found = null;
      for (const length of lengths) for (let at = 0; !found && at + length <= run.length; at += 1) found = phones.get(run.slice(at, at + length)) ?? null;
      if (found) hits.push({ start: match.index, end: match.index + match[0].length, kind: found.kind, token: found.token });
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const hit of hits) if (kept.length === 0 || kept.at(-1).end <= hit.start) kept.push(hit);
    return kept;
  };
}

/**
 * Compiles the whole export's dictionary once and returns `scrub(text)`: known identifiers become
 * their tokens (a name wins over a place of the same spelling), detectable patterns become
 * `[label]`, and `reliable` says whether the result may be kept. `places` should come from
 * `safePlaces`.
 */
export function createScrubber(known = [], { places = null, vocabulary = null } = {}) {
  const match = createMatcher(known);
  return (text) => {
    if (typeof text !== "string" || text === "") return { text: text ?? null, reliable: true, removed: 0 };
    let out = normaliseText(text);
    const hits = match(out);
    let removed = hits.length;
    for (const hit of [...hits].reverse()) out = out.slice(0, hit.start) + hit.token + out.slice(hit.end);
    for (const [label, pattern] of Object.entries(PATTERNS)) {
      out = out.replace(fresh(pattern), () => {
        removed += 1;
        return `[${label}]`;
      });
    }
    return { text: out, reliable: looksReliable(out, places, vocabulary), removed };
  };
}

/** One-off form of `createScrubber`. */
export function scrubText(text, known = [], places = null, vocabulary = null) {
  return createScrubber(known, { places, vocabulary })(text);
}

/**
 * The guard, compiled once over the originals: a function returning every original identifier and
 * every detectable pattern found in a prompt, with the same matching as the scrubber. Safe places
 * (`safePlaces`) are removed first, and so is a JSON `"municipality"` whose value is one of
 * `municipalities`: a case's location comes from the fixed list, so "St. Albert" there is not the
 * name Albert.
 */
export function createGuard(originals, places = null, municipalities = []) {
  const match = createMatcher(originals);
  const listed = new Set(municipalities.map((name) => normaliseText(name)));
  return (prompt) => {
    let text = normaliseText(prompt)
      .replace(/"municipality"\s*:\s*"([^"\\]*)"/g, (pair, value) => (listed.has(value) ? " " : pair))
      .replace(fresh(TOKEN), " ");
    if (places) text = text.replace(fresh(places), " ");
    const found = match(text).map(({ kind }) => ({ kind, reason: "mapped value" }));
    for (const [label, pattern] of Object.entries(PATTERNS)) if (fresh(pattern).test(text)) found.push({ kind: label, reason: "pattern" });
    return found;
  };
}

/** One-off form of the guard. */
export function promptViolations(prompt, originals, places = null, municipalities = []) {
  return createGuard(originals, places, municipalities)(prompt);
}

/**
 * Pseudonymises one exported record by the history spec's privacy block. Identifier fields become
 * tokens; address fields are removed and replaced by `generalise(record)`; free-text fields are
 * scrubbed (`scrub` from `createScrubber` over the whole export's dictionary, or one built from
 * `known`, `places`, and `vocabulary`) and dropped when unreliable or when they fail the guard.
 * Fields the spec does not name pass through, so callers copy only the fields they need into a case.
 */
export function pseudonymizeRecord(record, privacy, pseudonymizer, generalise, { known = [], places = null, vocabulary = null, scrub = null, guard = null } = {}) {
  const out = structuredClone(record);
  for (const [field, kind] of Object.entries(privacy.identifiers ?? {})) {
    if (out[field] === undefined || out[field] === null || out[field] === "") continue;
    out[field] = Array.isArray(out[field]) ? out[field].map((value) => pseudonymizer.token(kind, value)) : pseudonymizer.token(kind, out[field]);
  }
  for (const field of privacy.address ?? []) delete out[field];
  if ((privacy.address ?? []).length > 0) out.location = generalise(record);
  let dropped = 0;
  let kept = 0;
  const clean = scrub ?? createScrubber(known, { places, vocabulary });
  const check = guard ?? createGuard(pseudonymizer.originals(), places);
  for (const field of privacy.free_text ?? []) {
    if (typeof out[field] !== "string" || out[field] === "") continue;
    const scrubbed = clean(out[field]);
    if (scrubbed.reliable && check(scrubbed.text).length === 0) {
      out[field] = scrubbed.text;
      kept += 1;
    } else {
      out[field] = null;
      dropped += 1;
    }
  }
  return { record: out, dropped, kept };
}
