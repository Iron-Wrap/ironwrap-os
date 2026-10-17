import assert from "node:assert/strict";
import test from "node:test";

import { PII_PATTERNS, buildVocabulary, createGuard, createPseudonymizer, looksReliable, placesPattern, promptViolations, pseudonymizeRecord, safePlaces, scrubText } from "./privacy.mjs";

// Synthetic only: example.invalid addresses, 555-01xx numbers, invented names and streets.
const SALT = "synthetic-salt-0123456789";
const PRIVACY = {
  identifiers: { contact_id: "contact", display_name: "person", first_name: "person", last_name: "person", email: "email", phone: "phone", company: "company" },
  address: ["address_line1", "postal_code"],
  free_text: ["message", "notes"],
};
const PLACES = placesPattern(["Edmonton", "Red Deer", "St. Albert"]);
const record = () => ({
  contact_id: "JN-SYNTH-0001",
  display_name: "Renée O'Brien",
  first_name: "Renée",
  last_name: "O'Brien",
  email: "renee.obrien@example.invalid",
  phone: "780-555-0142",
  company: "Obrien Holdings",
  address_line1: "123 Example Street NW",
  postal_code: "T0T 0T0",
  city: "Edmonton",
  roof_squares: 31.5,
  message: "Renée O’Brien here, call (780) 555.0142 or renee.obrien@example.invalid about 24 sq ft of flashing near Red Deer.",
  notes: "Thanks, Priya for the walkthrough.",
});
const known = (pz) =>
  Object.entries(PRIVACY.identifiers).map(([field, kind]) => ({ kind, value: record()[field], token: pz.token(kind, record()[field]) }));

test("tokens are letters only, so none ever reads as a phone or account number", () => {
  const pz = createPseudonymizer(SALT);
  const tokens = Array.from({ length: 5000 }, (_, i) => pz.token("person", `Synthetic Person ${i}`));
  assert.ok(tokens.every((token) => /^person-[a-p]{10}$/.test(token)));
  assert.deepEqual(createGuard([])(tokens.join(" ")), []);
});

test("identifiers become stable tokens; addresses generalise; free text is scrubbed in any spelling or dropped", () => {
  const pz = createPseudonymizer(SALT);
  const { record: out, dropped } = pseudonymizeRecord(record(), PRIVACY, pz, (source) => ({ municipality: source.city }), { known: known(pz), places: PLACES });
  assert.match(out.display_name, /^person-[a-p]{10}$/);
  assert.equal(out.display_name, pz.token("person", "renée o'brien"), "tokens ignore case and spacing");
  assert.equal(out.address_line1, undefined);
  assert.deepEqual(out.location, { municipality: "Edmonton" });
  assert.equal(out.roof_squares, 31.5);
  assert.ok(!/O.?Brien|Ren[eé]e|555|example\.invalid/i.test(out.message), out.message);
  assert.match(out.message, /24 sq ft of flashing near Red Deer/);
  assert.equal(out.notes, null, "a greeting to an unlisted name is dropped");
  assert.equal(dropped, 1);
});

test("scrubText: phones, emails, rural and urban addresses, coordinates, and dates; measurements survive", () => {
  const text = [
    "Reach me on +1 780 555 0199 ext 12, at other@example.invalid or other [at] example [dot] invalid.",
    "Site is RR 2, Site 4, Box 5 off Township Road 524 and Rge Rd 231, legal NE-14-52-26-W4, PO Box 77, 52345 Hwy 21, Lot 4 Block 2 Plan 1234.",
    "Also 45 Sample Bay SW, 10234 82 Ave, 10234 Whyte NW, postal T0T 0T0, at 53.5461, -113.4938, on 2026-03-03.",
    "Measure 24 sq ft, 575 per sq, 3 rise, 4 layers in the park, 2 days to close.",
    "Crew on site 3 days a week, Lot 5 of materials, Comp 30 year shingles, the Hwy 2 side, 200 1500 sq ft, 2 hours drive.",
  ].join(" ");
  const scrubbed = scrubText(text, []);
  for (const leak of ["0199", "@", "[at]", "RR 2", "Site 4", "Box 5", "Township Road 524", "Rge Rd 231", "NE-14", "PO Box", "52345", "Lot 4", "Block 2", "Plan 1234", "Sample Bay", "82 Ave", "Whyte NW", "T0T", "53.5461", "2026-03-03"]) {
    assert.equal(scrubbed.text.includes(leak), false, `${leak} survives: ${scrubbed.text}`);
  }
  assert.match(scrubbed.text, /Measure 24 sq ft, 575 per sq, 3 rise, 4 layers in the park, 2 days to close\./);
  assert.match(scrubbed.text, /Crew on site 3 days a week, Lot 5 of materials, Comp 30 year shingles, the Hwy 2 side, 200 1500 sq ft, 2 hours drive\./);
  assert.equal(scrubText("install 2 new bay windows over a 3 car bay garage", []).text, "install 2 new bay windows over a 3 car bay garage");
  for (const street of ["i need a new roof at 123 oak street nw", "123 oak st", "14 oak street nw", "45 Sample Bay"]) {
    assert.equal(scrubText(street, []).text.includes("oak") || scrubText(street, []).text.includes("Sample"), false, street);
  }
});

test("a junk phone value never turns into an empty pattern", () => {
  const scrubbed = scrubText("Roof leaks over the garage.", [{ kind: "phone", value: "N/A", token: "phone-abcdefghij" }]);
  assert.equal(scrubbed.text, "Roof leaks over the garage.");
});

test("reliability: every word must be ordinary, in any case; trade notes, places, and dates keep the text", () => {
  for (const kept of [
    "Customer wants a quote for Galvalume panels in Red Deer.",
    "Left VM for person-abcdefghij.",
    "Will call back tomorrow. They will confirm the colour.",
    "Start in June, metal roof, Owens Corning shingles on the garage.",
    "i need a new roof at [street_address] edmonton",
    "ROOF LEAKING OVER THE GARAGE, ASAP",
    "Re-roof, tear off one layer, replaced flashing.",
    "White fascia and soffit. Price is 12k.",
    "May need a permit.",
  ]) {
    assert.equal(looksReliable(kept, PLACES), true, kept);
  }
  for (const dropped of [
    "Referred by Gordon from down the street.",
    "hi dave, quote sent.",
    "referred by gordon lightfoot",
    "dave henderson here, need a quote",
    "my husband bob will call",
    "call mike re quote",
    "its priya",
    "live at 45 birchwood, call after 5",
    "JOHN SMITH called",
    "SMITH, JOHN",
    "Grace called back",
    "April from next door wants a quote",
    "Bill sent the photos",
    "hi will, quote sent.",
    "Neighbour Green said ok",
    "White called back",
    "Price confirmed the deposit",
    "Brown from next door wants a quote",
    "Wood is coming tomorrow",
    "Will called back",
    "May called about the quote",
    "contact [mike] about the quote",
    "[street_address]",
  ]) {
    assert.equal(looksReliable(dropped, PLACES), false, dropped);
  }
});

test("towns count as places only in place context; a town name acting as a person is a name", () => {
  const towns = placesPattern(["Brooks", "Raymond", "Hanna", "Manning", "Jasper", "Devon", "Cochrane", "Strathcona County", "Red Deer"]);
  for (const kept of ["Roof replacement in Brooks.", "Job near Cochrane, AB", "Metal roof, Strathcona County.", "Crew from Red Deer.", "at [street_address] devon"]) {
    assert.equal(looksReliable(kept, towns), true, kept);
  }
  for (const dropped of [
    "Brooks asked for a quote.",
    "Raymond called about the roof.",
    "Hanna Manning wants a quote.",
    "spoke with Jasper",
    "Devon from next door wants a quote",
    "Cochrane said ok",
    "Quote for Mr. Brooks",
    "Met Hanna Manning in Red Deer.",
  ]) {
    assert.equal(looksReliable(dropped, towns), false, dropped);
  }
});

test("capitalised words: mid-sentence only weekdays, months, brands; before a person's verb only roles", () => {
  for (const kept of ["Customer called back.", "Kenroc called about the delivery.", "Quote confirmed for Friday.", "Order from Vicwest on Monday.", "I will call in March.", "2 Metal panels"]) {
    assert.equal(looksReliable(kept), true, kept);
  }
  for (const dropped of ["Gold called back", "Tan wants a quote", "Silver said ok", "Neighbour Gold said ok", "North called back", "called the Johnsons", "Metal Roof Quote Request"]) {
    assert.equal(looksReliable(dropped), false, dropped);
  }
});

test("vocabulary: words used lower case across many records count, except name parts, slotted words, and capitalised ones", () => {
  const texts = [
    ...Array.from({ length: 25 }, () => "sarking boards over the shop, called dave"),
    ...Array.from({ length: 40 }, () => "mike will drop the ladder"),
    ...Array.from({ length: 12 }, () => "then Mike drops it"),
    ...Array.from({ length: 25 }, () => "sent to fixture, then fixture review"),
    ...Array.from({ length: 25 }, () => "flashing per lisa"),
    ...Array.from({ length: 28 }, () => "leak over the kitchen"),
    ...Array.from({ length: 2 }, () => "started with kitchen leak"),
  ];
  const vocabulary = buildVocabulary(texts, { names: ["Morgan Fixture"], minRecords: 20 });
  assert.equal(vocabulary.has("sarking"), true);
  assert.equal(vocabulary.has("kitchen"), true, "an occasional object of 'with' is still a word");
  for (const word of ["dave", "mike", "fixture", "lisa"]) assert.equal(vocabulary.has(word), false, word);
  assert.equal(looksReliable("sarking boards lifting", null, vocabulary), true);
  assert.equal(looksReliable("Sarking boards lifting", null, vocabulary), false, "capitalised words must be listed");
  assert.equal(looksReliable("mike from the shop will drop the ladder", null, vocabulary), false);
});

test("scrub: one-word names only where capitalised, so ordinary words survive; addresses in any case", () => {
  const pz = createPseudonymizer(SALT);
  const known = ["White", "Black", "Green", "Will", "Mark", "Bill", "Grace", "Will Green"].map((value) => ({ kind: "person", value, token: pz.token("person", value) }));
  known.push({ kind: "address", value: "123 Example Street NW", token: pz.token("address", "123 Example Street NW") });
  const scrubbed = scrubText("Need a white fascia, black soffit and green panels. Will Green will mark the bill; Grace called. Meet at 123 example street nw.", known);
  assert.match(scrubbed.text, /^Need a white fascia, black soffit and green panels\. person-[a-p]{10} will mark the bill; person-[a-p]{10} called\./);
  assert.equal(/example street/i.test(scrubbed.text), false);
});

test("places: a town that shares a word with an export name is not protected, so the name is scrubbed", () => {
  const pz = createPseudonymizer(SALT);
  // As on contact records: the full name, and the first and last names on their own.
  const names = ["Raymond Brooks", "Raymond", "Brooks", "Hanna Manning", "Hanna", "Manning", "Albert"];
  const known = names.map((value) => ({ kind: "person", value, token: pz.token("person", value) }));
  const municipalities = ["Brooks", "Hanna", "Manning", "Raymond", "St. Albert", "Red Deer"];
  const safe = safePlaces(municipalities, names);
  assert.deepEqual(safe, ["Red Deer"]);
  const places = placesPattern(safe);
  for (const text of ["Brooks asked for a quote.", "Hanna Manning asked for a quote.", "Raymond Brooks asked for a quote."]) {
    const scrubbed = scrubText(text, known, places);
    assert.match(scrubbed.text, /^person-[a-p]{10} asked for a quote\.$/, text);
  }
  assert.equal(scrubText("Roof near Red Deer.", known, places).reliable, true);
  const guard = createGuard([...pz.originals(), { kind: "person", value: "Ab" }], places, { municipality: municipalities, province: ["AB"] });
  assert.deepEqual(guard(JSON.stringify({ location: { municipality: "St. Albert", province: "AB" }, note: "metal roof" })), [], "a location from the lists is not a name");
  assert.equal(guard(JSON.stringify({ note: "AB called" })).length, 1, "outside its key the same value still counts");
  assert.equal(guard("Albert asked for a quote").length, 1);
});

test("patterns stay fast on long and repetitive input", () => {
  for (const text of [" ".repeat(20000), "a".repeat(20000), "1.".repeat(10000), "Site 1 ".repeat(3000), "12 oak ".repeat(3000)]) {
    const start = Date.now();
    for (const pattern of Object.values(PII_PATTERNS)) text.replace(new RegExp(pattern.source, pattern.flags), "");
    assert.ok(Date.now() - start < 1000, `${text.slice(0, 8)}… took ${Date.now() - start} ms`);
  }
});

test("guard: one-word names count only capitalised; full names and patterns always count", () => {
  const originals = [
    { kind: "person", value: "Will Green" },
    { kind: "person", value: "Will" },
    { kind: "person", value: "Green" },
    { kind: "phone", value: "780-555-0142" },
  ];
  const guard = createGuard(originals);
  assert.deepEqual(guard("The roof will leak; they want green metal. Amount 780 then 5550142 later."), []);
  assert.deepEqual(guard("will green called").map((violation) => violation.kind), ["person"]);
  assert.ok(guard("Spoke with Green today").length > 0);
  assert.deepEqual(guard("call 780.555.0142").map((violation) => violation.reason).sort(), ["mapped value", "pattern"]);
  assert.deepEqual(promptViolations("Hendersons called", [{ kind: "person", value: "Henderson" }]), [{ kind: "person", reason: "mapped value" }]);
  for (const [prompt, value] of [["Henderson called", "HENDERSON"], ["Mcdonald called", "McDonald"], ["Renee OBrien called", "Renée O'Brien"]]) {
    assert.ok(promptViolations(prompt, [{ kind: "person", value }]).length > 0, prompt);
  }
  assert.deepEqual(promptViolations("at 123 example place nw", [{ kind: "address", value: "123 Example Place NW" }]), [{ kind: "address", reason: "mapped value" }]);
  assert.deepEqual(promptViolations("Roof in St. Albert", [{ kind: "person", value: "Albert" }], PLACES), [], "a listed place is not a name");
});
