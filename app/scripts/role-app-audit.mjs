/**
 * Role-app stabilization audit (Multica ELEC-157, Linear IRO-1).
 *
 * Walks every route each role app can reach, on a Pixel-class viewport, against a REAL
 * running stand (Worker + PWA + Frappe) rather than the acceptance-server fixtures. The
 * fixtures answer three modes (`field`, `estimator`, `accounting`); the five role apps
 * this audit covers only differ from each other once a real session carries a real role,
 * so the stand is the only place the difference is observable.
 *
 * What it records per route, as evidence rather than assertion:
 *   - a Pixel 5 screenshot;
 *   - horizontal overflow (the document scrolling wider than the viewport) and the
 *     widest offending elements, which is what a horizontal-scroll trap looks like;
 *   - visible interactive controls whose hit box is under the 44 px thumb floor;
 *   - the dead-end signature: an error/empty panel with no control inside it, i.e. a
 *     screen that tells the user something is wrong and offers no way forward;
 *   - every in-app link target, so a link to a route that does not exist is visible;
 *   - any user-visible administration-system vocabulary (Frappe/ERPNext/desk), which is
 *     the leak requirement 4 forbids.
 *
 * Usage (stand must be up — `~/ironwrap-local/start.sh`):
 *   node scripts/role-app-audit.mjs
 *   BUS=https://localhost:7100 ADMIN_TOKEN=... node scripts/role-app-audit.mjs
 *   ROLES=owner,sales node scripts/role-app-audit.mjs      # subset
 *   AUDIT_PROFILE=desktop AUDIT_COLOR_SCHEME=dark node scripts/role-app-audit.mjs
 *
 * Writes `output/role-app-audit/report.json` plus one screenshot per route. `output/` is
 * git-ignored: this produces evidence to read, never a committed artifact.
 */
import { chromium, devices } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUS = process.env.BUS ?? "http://localhost:7300";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "local-throwaway-admin-token";
const TENANT = process.env.TENANT ?? "ironwrap";
const AUDIT_PROFILE = process.env.AUDIT_PROFILE ?? "mobile";
const AUDIT_COLOR_SCHEME = process.env.AUDIT_COLOR_SCHEME ?? "light";
if (!new Set(["mobile", "desktop"]).has(AUDIT_PROFILE)) {
  throw new Error(`unsupported AUDIT_PROFILE: ${AUDIT_PROFILE}`);
}
if (!new Set(["light", "dark"]).has(AUDIT_COLOR_SCHEME)) {
  throw new Error(`unsupported AUDIT_COLOR_SCHEME: ${AUDIT_COLOR_SCHEME}`);
}
const AUDIT_VARIANT =
  AUDIT_PROFILE === "mobile" && AUDIT_COLOR_SCHEME === "light"
    ? ""
    : `-${AUDIT_PROFILE}-${AUDIT_COLOR_SCHEME}`;
const TARGET_SIZE = AUDIT_PROFILE === "mobile" ? 44 : 24;
const OUT_DIR = resolve(
  fileURLToPath(new URL(`../output/role-app-audit${AUDIT_VARIANT}/`, import.meta.url)),
);

// The stand serves wrangler's self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/**
 * Route inventory per role app. `nav` routes are the ones the role's own navigation
 * offers; `reachable` routes are ones the role can be sent to by a link, a Now card, or
 * a typed URL — a role app is only stable if those land somewhere usable too.
 */
const ROLE_APPS = {
  owner: {
    email: "owner@ironwrap.local",
    routes: [
      "/now",
      "/owner",
      "/newo",
      "/sales",
      "/facet-designs",
      "/production",
      "/production/schedule-approvals",
      "/service",
      "/today",
      "/inventory",
      "/approvals",
      "/quote-revision-approvals",
      "/accounting",
      "/accounting/exceptions",
      "/accounting/quickbooks",
      "/settings",
    ],
  },
  sales: {
    email: "sales@ironwrap.local",
    routes: ["/now", "/sales", "/settings", "/production", "/accounting"],
  },
  production: {
    email: "production@ironwrap.local",
    routes: [
      "/now",
      "/production",
      "/production/schedule-approvals",
      "/settings",
      "/sales",
      "/inventory",
    ],
  },
  accounting: {
    email: "accounting@ironwrap.local",
    routes: [
      "/now",
      "/accounting",
      "/accounting/exceptions",
      "/accounting/quickbooks",
      "/settings",
      "/sales",
      "/production",
    ],
  },
  field: {
    pairing: true,
    email: "crew@ironwrap.local",
    routes: ["/now", "/today", "/check-in", "/vehicle", "/inventory", "/settings"],
  },
};

async function api(path, init = {}) {
  const response = await fetch(`${BUS}${path}`, {
    ...init,
    headers: { Origin: BUS, ...(init.headers ?? {}) },
  });
  return response;
}

async function mintMagicLinkToken(email) {
  const before = await newestCaptureAt(email, "magic_link");
  const requested = await api("/api/v1/auth/magic-link/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: TENANT, email }),
  });
  if (!requested.ok) throw new Error(`magic-link request failed for ${email}: ${requested.status}`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const capture = await newestCapture(email, "magic_link");
    if (capture && (!before || capture.created_at > before)) return capture.href;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(
    `no fresh magic link for ${email}. The stand throttles 5 links per email per 15 minutes.`,
  );
}

async function captures() {
  const response = await api("/admin/dev-outbox?limit=50", {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!response.ok) throw new Error(`dev-outbox unavailable: ${response.status}`);
  return (await response.json()).captures ?? [];
}

async function newestCapture(recipient, kind) {
  return (
    (await captures()).find(
      (capture) => capture.recipient === recipient && capture.kind === kind,
    ) ?? null
  );
}

async function newestCaptureAt(recipient, kind) {
  return (await newestCapture(recipient, kind))?.created_at ?? "";
}

/** Owner cookie session, used to issue the field device pairing code. */
async function ownerSession() {
  const href = await mintMagicLinkToken(ROLE_APPS.owner.email);
  const token = decodeURIComponent(new URL(href).hash.split("=")[1]);
  const response = await api("/api/v1/auth/magic-link/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(`owner sign-in failed: ${response.status}`);
  const cookie = (response.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
  const body = await response.json();
  if (!cookie || !body.csrf_token) throw new Error("owner sign-in returned no session");
  return { cookie, csrf: body.csrf_token };
}

async function mintPairingUrl(session) {
  const users = await api("/api/v1/field-users", {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf },
  });
  if (!users.ok) throw new Error(`field-users unavailable: ${users.status}`);
  const list = (await users.json()).users ?? [];
  const crew = list.find((user) => user.email === ROLE_APPS.field.email) ?? list[0];
  if (!crew) throw new Error("no active field user on this stand");
  const issued = await api("/api/v1/device-pairings", {
    method: "POST",
    headers: {
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ field_user_id: crew.id }),
  });
  const body = await issued.json();
  if (!body.pairing_url) throw new Error(`pairing issue failed: ${JSON.stringify(body)}`);
  return body.pairing_url;
}

/**
 * Runs inside the page. Everything here is observation — it never clicks, so a walk of a
 * role app cannot change the stand's state.
 */
const INSPECT = (targetSize) => {
  const viewport = window.innerWidth;
  const doc = document.scrollingElement ?? document.documentElement;
  const overflowBy = Math.max(0, Math.round(doc.scrollWidth - viewport));

  const wideElements = [];
  const touchViolations = [];
  const seenTouch = new Set();

  const describe = (element) => {
    const id = element.id ? `#${element.id}` : "";
    const cls =
      typeof element.className === "string" && element.className
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
    const label = (element.getAttribute("aria-label") ?? element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    return { selector: `${element.tagName.toLowerCase()}${id}${cls}`, label };
  };

  for (const element of document.querySelectorAll("body *")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > viewport + 1 || rect.left < -1) {
      wideElements.push({
        ...describe(element),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      });
    }
  }

  const interactive = document.querySelectorAll(
    'a[href], button, summary, [role="button"], input:not([type="hidden"]), select, textarea',
  );
  for (const element of interactive) {
    // A checkbox or radio inside its own <label> is toggled by the whole label, so the
    // label's box is the real thumb target. Measuring the 20 px box alone reports a
    // defect that does not exist on the phone.
    const target =
      (element.tagName === "INPUT" &&
        (element.type === "checkbox" || element.type === "radio") &&
        element.closest("label")) ||
      element;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (element.closest("[popover]:not(:popover-open)")) continue;
    if (rect.height >= targetSize && rect.width >= targetSize) continue;
    const described = describe(element);
    const key = `${described.selector}|${described.label}|${Math.round(rect.height)}`;
    if (seenTouch.has(key)) continue;
    seenTouch.add(key);
    touchViolations.push({
      ...described,
      height: Math.round(rect.height),
      width: Math.round(rect.width),
    });
  }

  // The dead-end signature: a state panel (error or empty) that carries no control.
  const statePanels = [];
  for (const heading of document.querySelectorAll("h1, h2")) {
    const panel = heading.closest("[aria-live], [role='alert']");
    if (!panel) continue;
    statePanels.push({
      title: heading.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "",
      message:
        panel.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "",
      controls: panel.querySelectorAll("a[href], button").length,
    });
  }

  const links = [
    ...new Set(
      [...document.querySelectorAll("a[href]")]
        .map((anchor) => anchor.getAttribute("href") ?? "")
        .filter((href) => href.startsWith("/")),
    ),
  ];

  const bodyText = document.body.innerText ?? "";
  const adminVocabulary = [
    ...new Set(
      (bodyText.match(/\b(Frappe|ERPNext|Desk|DocType|Administrator)\b/g) ?? []).map((hit) => hit),
    ),
  ];

  return {
    title: document.title,
    heading: document.querySelector("main h1")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    overflowBy,
    wideElements: wideElements.slice(0, 12),
    touchViolations: touchViolations.slice(0, 20),
    statePanels,
    links,
    adminVocabulary,
    textSample: bodyText.replace(/\s+/g, " ").trim().slice(0, 400),
  };
};

async function walkRole(browser, role, app, session) {
  const context = await browser.newContext({
    ...(AUDIT_PROFILE === "desktop"
      ? { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }
      : devices["Pixel 5"]),
    colorScheme: AUDIT_COLOR_SCHEME,
    ignoreHTTPSErrors: true,
    baseURL: BUS,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  const failedRequests = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith("/api/"))
      failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  if (app.pairing) {
    const pairingUrl = await mintPairingUrl(session);
    await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
  } else {
    const href = await mintMagicLinkToken(app.email);
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
  }

  const signedIn = await page.evaluate(() => window.location.pathname);
  const results = [];
  for (const route of app.routes) {
    consoleErrors.length = 0;
    failedRequests.length = 0;
    await page.goto(route, { waitUntil: "domcontentloaded" });
    // Role surfaces load their read model after paint; give the query a real window
    // rather than sampling the skeleton and calling it an empty state.
    await page.waitForTimeout(3500);
    const inspection = await page.evaluate(INSPECT, TARGET_SIZE);
    const shot = `${role}${route.replaceAll("/", "_") || "_root"}.png`;
    await page.screenshot({ path: resolve(OUT_DIR, shot), fullPage: true });
    results.push({
      route,
      landedOn: new URL(page.url()).pathname,
      screenshot: shot,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 5),
      failedRequests: [...new Set(failedRequests)].slice(0, 8),
      ...inspection,
    });
    process.stdout.write(
      `  ${role.padEnd(11)} ${route.padEnd(38)} overflow=${String(inspection.overflowBy).padStart(4)}px  ` +
        `target<${TARGET_SIZE}=${String(inspection.touchViolations.length).padStart(2)}  ` +
        `panels=${inspection.statePanels.length}  admin=${inspection.adminVocabulary.join(",") || "-"}\n`,
    );
  }

  await context.close();
  return { role, signedInAt: signedIn, routes: results };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const only = process.env.ROLES?.split(",").map((value) => value.trim());
  const health = await api("/health");
  if (!health.ok) throw new Error(`stand not answering on ${BUS} (/health ${health.status})`);

  const browser = await chromium.launch();
  const session = await ownerSession();
  const report = {
    bus: BUS,
    profile: AUDIT_PROFILE,
    color_scheme: AUDIT_COLOR_SCHEME,
    target_size: TARGET_SIZE,
    generated_at: new Date().toISOString(),
    roles: [],
  };
  try {
    for (const [role, app] of Object.entries(ROLE_APPS)) {
      if (only && !only.includes(role)) continue;
      process.stdout.write(`\n${role}\n`);
      report.roles.push(await walkRole(browser, role, app, session));
    }
  } finally {
    await browser.close();
  }
  await writeFile(resolve(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nreport: ${resolve(OUT_DIR, "report.json")}\n`);
}

await main();
