# Website → Bus Integration (point the lead forms at the bus)

The lead bus is live and verified to accept website form posts (JSON **and**
`application/x-www-form-urlencoded`). To capture leads, the website's form handler must
**forward each submission to the bus, server-side.**

- **Endpoint:** `POST https://ironwrap-bus.yellow-rain-7498.workers.dev/ingest/website`
- **Auth:** header `Authorization: Bearer <INGEST_TOKEN>` — the token is **server-side only**
  (set as an env var; **never** ship it to the browser).
- **Body:** the form fields as-is (the bus normalizes phone/email and maps `first_name`/`last_name`,
  `phone`, `email`, `service`, `message`, etc.), **plus**:
  - `brand`: `"ironwrap"` on ironwrapexteriors.com · `"iroof"` on iroofalberta.ca
  - attribution (hidden fields — also a website audit Quick Win): `source_url`, `page_type`
    (home/quote/contact/service/city/blog), `utm_source/medium/campaign/content/term`.
- **Response:** `{ envelope_id, status, duplicate, queue }`. The bus stores the lead, fires the
  (interim email) instant-ack, dedupes, and pushes to JobNimbus via its queue.

## Where it goes (Next.js)
The site is a Next.js app; forms post to an internal route (e.g. `app/api/lead/route.ts`). Add the
bus forward there — keep any existing behavior, just **also** send to the bus. This keeps the token
server-side and never breaks the visitor's experience if the bus hiccups.

```ts
// Inside your existing form Route Handler (server-side). Drop-in:
async function forwardToBus(data: Record<string, unknown>, req: Request) {
  try {
    await fetch("https://ironwrap-bus.yellow-rain-7498.workers.dev/ingest/website", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.IRONWRAP_BUS_INGEST_TOKEN}`, // server-side env var
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...data,
        brand: "ironwrap",                         // "iroof" on the iRoof Alberta site
        source_url: data.source_url ?? req.headers.get("referer") ?? "",
        page_type: data.page_type ?? "",
      }),
    });
  } catch (e) {
    console.error("bus ingest failed (lead not lost — investigate)", e); // never throw to the user
  }
}
```

Standalone version if you'd rather add a fresh route:

```ts
// app/api/lead-to-bus/route.ts
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") || "";
  const data = ct.includes("application/json")
    ? await req.json()
    : Object.fromEntries(await req.formData());
  await forwardToBus(data, req);   // function above
  return Response.json({ ok: true });
}
```

## Setup steps (whoever owns the website)
1. In your hosting (Vercel/…) set env var **`IRONWRAP_BUS_INGEST_TOKEN`** = the `INGEST_TOKEN`
   retrieved through the approved secret store or owner-only handoff. Never place it in chat, source,
   or client-side code. Set it for **both** brand sites.
2. Add `forwardToBus(...)` to each lead form's server handler (home, quote, contact, service pages).
3. Ensure forms send `brand` + the hidden attribution fields (`source_url`, `page_type`, `utm_*`).
4. Deploy; submit one test from each form; confirm it appears in JobNimbus (and in the bus D1).

## Quick test (server-side, replace the token)
```bash
curl -X POST https://ironwrap-bus.yellow-rain-7498.workers.dev/ingest/website \
  -H "Authorization: Bearer $IRONWRAP_BUS_INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"first_name":"Test","last_name":"Lead","email":"t@example.com","phone":"5875550000","service":"metal roofing","brand":"ironwrap","source_url":"https://ironwrapexteriors.com/quote/","page_type":"quote"}'
# → {"envelope_id":"ow_…","status":"pending_jn_push","queue":"residential_sales"}
```

> Once live, this replaces the experimental GHL webform path (`final-spec-pack/16`, DELIVERY-PLAN
> Phase 1). The bus dedupes, dead-letters, reconciles, and pushes to JobNimbus automatically.
