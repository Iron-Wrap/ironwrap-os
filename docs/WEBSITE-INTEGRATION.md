# Website Intake Integration

The Worker implements website intake for JSON and `application/x-www-form-urlencoded` requests.
This runbook does not establish that any website or Worker deployment is live. A website form
handler must submit server-side and report success only after the bus returns an owned-intake
receipt.

- **Endpoint:** `POST <IRONWRAP_BUS_ORIGIN>/ingest/website`
- **Auth:** header `Authorization: Bearer <INGEST_TOKEN>` — the token is **server-side only**
  (set as an env var; **never** ship it to the browser).
- **Body:** the form fields as-is (the bus normalizes phone/email and maps `first_name`/`last_name`,
  `phone`, `email`, `service`, `message`, etc.), **plus**:
  - `brand`: `"ironwrap"` on ironwrapexteriors.com · `"iroof"` on iroofalberta.ca
  - attribution (hidden fields — also a website audit Quick Win): `source_url`, `page_type`
    (home/quote/contact/service/city/blog), `utm_source/medium/campaign/content/term`.
- **Response:** `{ envelope_id, status, duplicate, queue }`. This proves only owned intake.
  Acknowledgement and downstream bridge delivery require their own evidence.

## Next.js server handler

For a Next.js marketing site, call the bus from a server route. The browser must retain entered
values and present a retryable error when the server returns `503`; never show success after a
failed owned intake.

```ts
async function forwardToBus(data: Record<string, unknown>, req: Request) {
  const origin = process.env.IRONWRAP_BUS_ORIGIN;
  const token = process.env.IRONWRAP_BUS_INGEST_TOKEN;
  if (!origin || !token) throw new Error("website intake is not configured");

  const response = await fetch(new URL("/ingest/website", origin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...data,
      brand: "ironwrap", // use the configured iRoof key on the iRoof Alberta site
      source_url: data.source_url ?? req.headers.get("referer") ?? "",
      page_type: data.page_type ?? "",
    }),
  });
  if (!response.ok) throw new Error(`owned intake rejected with HTTP ${response.status}`);
  return response.json();
}
```

Example route:

```ts
// app/api/lead-to-bus/route.ts
export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await req.json()
      : Object.fromEntries(await req.formData());
    return Response.json(await forwardToBus(data, req));
  } catch {
    console.error("owned website intake failed");
    return Response.json({ ok: false, retryable: true }, { status: 503 });
  }
}
```

## Setup steps (whoever owns the website)
1. In the website host set **`IRONWRAP_BUS_ORIGIN`** to the deployed Worker origin and
   **`IRONWRAP_BUS_INGEST_TOKEN`** to the `INGEST_TOKEN`
   retrieved through the approved secret store or owner-only handoff. Never place it in chat, source,
   or client-side code. Set it for **both** brand sites.
2. Add `forwardToBus(...)` to each lead form's server handler (home, quote, contact, service pages).
3. Ensure forms send `brand` + the hidden attribution fields (`source_url`, `page_type`, `utm_*`).
4. Deploy; submit one synthetic test from each form; verify the exact envelope in D1, then verify
   each enabled acknowledgement and downstream delivery independently.

## Public Instant-Estimate Embed

The public estimator is a separate browser route: `GET /estimate` loads the PWA and its own
same-origin `GET/POST /public/instant-estimate*` calls. It never receives `INGEST_TOKEN` and must
not be proxied through a marketing form handler.

After the Worker/PWA release is configured and live-proven, embed it with a fixed HTTPS source:

```html
<iframe
  src="https://<estimate-pwa-origin>/estimate?brand=ironwrap"
  title="Request a non-binding exterior estimate"
  loading="lazy"
  style="width:100%; min-height:900px; border:0"
></iframe>
```

For the iRoof Alberta site, use the same release with `?brand=iroof`. The query value is a
bounded tenant-brand key, becomes part of the canonical lead envelope, and must be present in
`PUBLIC_ESTIMATE_ALLOWED_BRANDS`; do not infer the brand from `Referer` or a free-form browser
field.

Two allowlists protect different boundaries and must not be mixed up:

- `PUBLIC_ESTIMATE_ALLOWED_ORIGINS` is the exact origin serving the PWA/Worker route (the
  iframe's own origin). It governs browser API requests.
- `app/public/_headers` limits `/estimate` embedding with `frame-ancestors`; add only the exact
  marketing sites authorized to host the iframe.

Do not enable the embed until the Worker has a real Turnstile widget/secret, a unique rate-limit
pepper, the dedicated `ERPNEXT_INTEGRATION_USER`, and the exact empty range array `[]`, plus the tenant's explicit
`PUBLIC_ESTIMATE_CONSENT_JURISDICTION`. A live proof must show that the public response contains no
submitted contact/address data or numeric price and that consent reaches the owned raw/Frappe
evidence path. Any non-empty range array fails readiness.

## Quick test (server-side, replace the token)
```bash
curl -X POST "$IRONWRAP_BUS_ORIGIN/ingest/website" \
  -H "Authorization: Bearer $IRONWRAP_BUS_INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"first_name":"Test","last_name":"Lead","email":"lead@example.invalid","phone":"5875550000","service":"metal roofing","brand":"ironwrap","source_url":"https://ironwrapexteriors.com/quote/","page_type":"quote"}'
# Preserve the returned envelope_id as the owned-intake receipt.
```

When deployment and reconciliation evidence pass the authority contract, this owned route may
replace the corresponding bridge intake. Dedupe, dead-letter handling, reconciliation, and any
bridge push remain separate evidenced outcomes; intake success must never imply bridge delivery.
