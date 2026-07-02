# 08 - Costs, Vendors, And Buy Gates

Date: 2026-06-28

Prices change often. Re-check before purchase. Vendors bill in USD; figures below
are USD unless marked CAD. For CAD, load ~1.40 FX + GST (~5%). GHL was
trial-evaluated only and is being declined before any production use; nothing to
migrate — end the trial. JobNimbus is the operational CRM / job-truth, fronted by
an integration bus (Make, or a Cloudflare Workers + D1 + R2 + Queues + Cron bus —
see the bus note below) and an owned Cloudflare D1+R2 data layer that every
scenario dual-writes to first.

## Recommended Budget To Present First

| Scenario | Monthly Estimate | One-Time Estimate | Recommendation |
|---|---:|---:|---|
| Existing-subscription first deliverable | ~CAD $120-$220/mo incremental (loaded) | ~CAD $700-$2,100 setup (**"$0 new vendor setup" is false** — Cloudflare, the ESP, the owned Twilio number, and (if adopted) DocuSeal are new vendor lines) | Default first delivery (keystone: decline GHL trial, stand up JN spine + Make/Workers bus + owned store) |
| Low-volume operating spine | CAD $900-$1,900 all-in, or CAD $50-$350 incremental if current subscriptions are already paid | CAD $400-$1,500 (setup) | Best immediate target |
| Lean build/test with AI pilot | CAD $1,100-$2,200 | CAD $400-$2,000 | Use during active build/config/test |
| Expansion after volume proof | CAD $3,500-$5,000 | CAD $8,000-$12,000 | Only if Renoworks/report volume is justified |
| Full future stack | CAD $4,500-$6,200 | CAD $18,800+ known setup fees | Deferred |

## Core Run-Rate Planning

| Tool | Planning Estimate | Decision |
|---|---:|---|
| JobNimbus (seats) | Already subscribed; USD ~$200-$300/mo headline at current seats; **budget ~1.8× headline all-in** with add-ons | Operational CRM / job-truth; keep and configure. **Audit the tier/seats:** if the shop fits the "Growing" tier (~USD $349/mo ≈ CAD ~$475 loaded) it is *below* the ~CAD $660 estimate; the real constraint is the 10-automation / 5-integration cap. Cheapest legitimate saving here is a tier/seat audit, NOT a CRM swap |
| JobNimbus Engage (2-way SMS) | USD ~$49/mo + SMS usage | P0 for 2-way SMS; fresh A2P 10DLC + Canadian carrier registration required first (~1-3 wks lead time) |
| JobNimbus AssistAI (phone AI) | USD ~$0.15/voice-min, metered ≈ $15-30/mo at low volume; **enforce a hard monthly minute cap / budget alert** (cap = owner-set, e.g. ~500 min/mo; verify AssistAI's native cap support — it bills pure-metered, so if there is no native cap, enforce via usage monitoring + an overage alert; keeps the spam/robocall buffer rationale) | P0 native receptionist behind a written scored eval gate |
| Email — brand mailboxes (**Microsoft 365** for IronWrap `quote@ironwrapexteriors.com`; **Gmail** for iRoof `info@iroofalberta.ca`) | Already subscribed; **$0 incremental**; SPF/DKIM/DMARC + bounce monitoring on each domain | P0 — JN native email is unreliable; send transactional/instant-ack/notification email from the brand mailboxes. A dedicated transactional ESP (Resend ≈ $0 / Postmark ~$15) is **deferred** — add only for bulk nurture/review deliverability. Self-hosting the send path stays rejected |
| Twilio Canadian DID (owned number) | USD ~$1/mo per number + per-minute/per-SMS usage | Own the DID so AssistAI↔Retell swaps are config-only |
| Jotform (structured field forms) | USD ~$39/mo (paid tier for offline app / more submissions) | P0 host of the "Jobsite Photo" form (geo + photos); reuses already-paid Jotform — $0 incremental for jobsite photos |
| Jotform "Jobsite Photo" form (jobsite photos/geo) | **$0 incremental** (reuses paid Jotform) | **P0 default** — JN job picker + Geolocation widget (device GPS at submit, offline-capable in Jotform Mobile App) + multi-photo upload + timestamp → Make → OneDrive/JN + owned store. EXIF-on-iOS is stripped on-device, so device-GPS-at-capture is the mechanism (not photo EXIF) |
| Design tooling (free Canva + free Affinity) | CAD $0 | **Free Canva + free Affinity** (Designer/Photo/Publisher went 100% free Oct 2025, Canva-owned) covers a roofer's marketing/proposal graphics; Canva Pro (~CAD $18/mo) only if brand-kit/background-remover/team features are needed; reject full Adobe Creative Cloud (~CAD $92/mo) |
| Cloudflare Pages / D1 / R2 (owned store) | ~USD $0 at this volume (free tiers) | Owned system of record; dual-write FIRST, then JN |
| Cloudflare Workers (+ D1 + R2 + Queues + Cron bus option) | ~CAD $7/mo (Workers+D1+R2+Queues+Cron bus) | Relay/health-check beyond D1/R2/Pages; **can also host the integration bus** (Queues = native retry + dead-letter, Cron = daily reconcile, dual-write collapses to a single write) vs scaling Make on its credit model. **Hybrid:** Worker does the heavy lifting, keep a Make Core seat (~$9/mo) for native connectors + observability. Caveat: adds owned code a no-devops shop must maintain — name a build/maintenance owner |
| Google Business Profile | CAD $0 | Audit and maintain |
| Google Local Services Ads | Pay-per-lead, category/location dependent | Do not spend until intake QA passes |
| Make (integration bus) | **Already on Core** (~$9/mo USD ≈ CAD ~$13; credit model, Aug 2025; 10,000 ops/mo ceiling) — **no tier bump needed** at this volume; watch the ops ceiling as scenarios grow | **Critical infra**, not plumbing — keep, clean, monitor. The bus can alternatively run on Cloudflare Workers (hybrid keeps the Make Core seat) — see the Cloudflare Workers row |
| QuickBooks | Already subscribed; CAD $80-$200/mo planning value | Accounting truth |
| Microsoft 365 (OneDrive + Outlook) | Already subscribed | **Storage authority** (OneDrive job-folder archive) + IronWrap email sender. A secondary Google Workspace account exists (agency / iRoof Gmail) but is not the storage authority |
| RoofRuler | Already subscribed/used; otherwise CAD ~$40/report | Pay per qualified report only |
| OCR ladder (Cloudflare `toMarkdown()` → Mistral OCR) | CAD $0 first pass (Cloudflare `toMarkdown()`, free Workers AI binding); Mistral OCR ~$2-$4 per 1,000 pages → cents/mo at this volume, only for image-heavy/scanned/handwritten/layout-sensitive docs | Free on-stack first pass; Mistral as the cheap paid fallback only (do NOT self-host an OCR engine — needs a GPU box) |

## All-In CAD TCO (Expected Case)

Every USD line ×1.40 FX + ~5% GST. JobNimbus modeled at **~1.8× headline** (add-on
creep / lock-in). AssistAI carries a **spam/robocall buffer** (uncapped inbound
junk burns paid minutes). Make is on the Aug-2025 credit model (Core ~$9 / Pro ~$16).
This is the **all-in run-rate** — existing subscriptions repriced from zero — NOT the
first-deliverable incremental (that is **~CAD $120-$220/mo**; see the budget table and
the GHL note below). The two numbers answer different questions.

| Line | USD headline | Expected-case CAD/mo (incl. FX + GST) |
|---|---:|---:|
| JobNimbus seats (×1.8 model) | ~$250 | ~CAD $660 |
| JobNimbus Engage + SMS usage | ~$49 + usage | ~CAD $90-$140 |
| AssistAI minutes (+ spam buffer) | ~$15-30 | ~CAD $35-$70 |
| Email — Microsoft 365 brand mailboxes (existing; dedicated ESP deferred) | existing | ~CAD $0 incremental |
| Twilio Canadian DID + usage | ~$1 + usage | ~CAD $5-$30 |
| Jotform (paid tier; hosts "Jobsite Photo" form — $0 incremental for photos/geo) | ~$39 | ~CAD $55 |
| Jotform "Jobsite Photo" form (photos/geo) | $0 incremental | ~CAD $0 (reuses Jotform above) |
| Design (free Canva + free Affinity) | — | ~CAD $0 |
| Cloudflare Pages/D1/R2 (+ Workers bus option ~CAD $7) | ~$0 | ~CAD $0 (Workers bus ~CAD $7 if adopted) |
| Make (credit model: Core ~$9 / Pro ~$16 USD) | existing | ~CAD $15-$30 |
| **All-in run-rate subtotal** (existing subscriptions repriced from zero — this is the ALL-IN figure, **NOT** the first-deliverable incremental) | | **~CAD $940-$1,310/mo** |

**One-time setup costs:**

GHL was trial-evaluated only and is being declined before any production use —
there is no GHL production data, number, conversation history, or CASL consent
records to migrate. The one-time spend below is standing up the JobNimbus spine,
not migrating off GHL.

| One-time item | Expected-case CAD |
|---|---:|
| Fresh A2P 10DLC + Canadian carrier registration (not a re-registration) | ~CAD $50-$150 + labour |
| Provision/own the business DID in Twilio (portable, AssistAI/Engage) | ~CAD $0-$50 + labour |
| Build automations on Make (envelope, dead-letter, dedup, reconcile) | ~CAD $300-$900 (labour) |
| ESP setup + SPF/DKIM/DMARC + seed/deliverability test | ~CAD $100-$300 |
| Verify existing website form post destinations and point them at the Make bus | ~CAD $100-$300 (labour) |
| Staff training (JN-first intake, instant-ack, reconciliation owner) | ~CAD $150-$400 (labour) |
| **One-time setup subtotal** | **~CAD $700-$2,100** |

**Cost position vs GHL:** GHL was never adopted, so this **avoids ~CAD
$135-$415/mo of GHL cost** entirely. The honest **first-deliverable incremental is
~CAD $120-$220/mo** (loaded, incl. ~1.40 FX + GST). The driver is **JobNimbus Engage
(~CAD $90-$140 loaded with SMS usage)**; the rest is small — Twilio DID + usage
(~CAD $5-$30), a Make Core seat or the bus on Cloudflare Workers (~CAD $20-$30), and
the A2P monthly campaign fee (~CAD $5-$15). Cloudflare D1/R2/Workers ≈ $0, the ESP ≈
$0 (Resend's free tier likely covers low volume), design = $0 (free Canva + free
Affinity). **AssistAI minutes are a Phase-2 (post-eval) cost (~CAD $35-$70 loaded when
live), not part of the first-deliverable incremental.** This is distinct from the
**~CAD $940-$1,310/mo all-in run-rate** above (existing subscriptions repriced from
zero). Frame this as **"simpler, more portable, and avoids GHL's cost"** — not as a
saving from cancelling a live system, because there is no live GHL system. The durable
win is portability (owned D1/R2 data) + simplicity + reliability, on a CASL consent
ledger maintained in JobNimbus going forward (no historical GHL export needed).

## Phone AI Alternatives

AssistAI is primary (native, on the platform we standardize on; **books natively
into the JobNimbus calendar** and creates the lead record in-CRM — Make is used for
route-flagging + the owned-store dual-write, not necessarily the booking call). The
hand-assembled Retell+Twilio+Gemini+ElevenLabs 4-vendor DIY stack is **removed as a
planned build** (re-introduces the on-call engineer burden that disqualified Vapi).
Vapi excluded (needs on-call engineer); **Google Voice** excluded (no real-time media
API) — do not conflate with Google's **Gemini Live API** (a real-time voice API and a
legitimate LLM-voice backend); only the *Google Voice* consumer product is excluded.
Floor fallback always = voicemail → JobNimbus lead + human callback.

| Provider | Planning Estimate For 500 AI Minutes | Use When |
|---|---:|---|
| **JobNimbus AssistAI** | USD ~$0.15/min ≈ CAD $105/500min all-in; metered, **enforce an owner-set monthly minute cap / budget alert** (e.g. ~500 min/mo) | **P0 default** — behind written scored eval gate (≥85% capture+routing, zero catastrophic failures) |
| Voicemail → JN lead + human callback | CAD $0 | **Floor fallback** — never breaks, zero ops |
| Managed Retell (bundled telephony/LLM/voice) | CAD $78-$220/mo | **Tier 2 — only if AssistAI fails the eval gate** — one managed config, DID re-pointed (config-only) |
| Managed-OSS voice (LiveKit Cloud / Pipecat Cloud) | Usage-based hosting | **Tier 2.5 — only if both AssistAI and managed Retell fail the eval** — managed hosting removes the "media server to babysit" problem, but you still own the agent code/prompt/booking-glue, so it sits below the two fully-managed options |
| ~~4-vendor DIY (Retell+Twilio+Gemini+ElevenLabs)~~ | — | **Killed** — no standing custom voice stack |
| ~~Vapi~~ | — | Excluded (needs on-call engineer) |
| ~~Google Voice ↔ Cloud ↔ ElevenLabs~~ | — | Excluded (no real-time media API) |

## Expensive Add-Ons

| Tool | Estimate | Gate |
|---|---:|---|
| RoofRuler | CAD ~$40/report; CAD $2,400/mo only at 60 reports | Pay per qualified report first |
| Renoworks | CAD $8,000 setup + CAD ~$378/mo | Add only if visualizer-led selling is core |
| Jotform (paid tier / API) | USD ~$39/mo+ | Add only when a structured field workflow becomes daily and painful |
| CallRail | Paid call/source attribution; pricing by plan/usage | **Deferred.** Add only when paid ads start (interim: UTM + manual Lead Source + 1 tracked number) |
| Paradigm | CAD $10,800 setup + CAD ~$673/mo | Deferred; add only after manual material flow is stable |
| DocuSeal (OSS e-sign escape hatch) | Managed DocuSeal Cloud ~CAD $30/mo, or one self-hosted container | **Escape hatch if JobNimbus native e-sign / HTML+PDF fails the workflow** — open-source (AGPLv3), legally valid in Canada (audit-trail PDF; PIPEDA / Alberta ETA recognize ordinary commercial e-signatures), webhooks in the free edition fire completion back through Make → JobNimbus. **Permanently retires the PandaDoc/DocuSign line.** Caveat: AGPL — deploy stock and integrate via API/webhook (don't fork); signer page shows DocuSeal branding unless Pro |
| Acrobat Pro (standalone) | future-maybe | Only if a real fillable-PDF gap remains (not a structured-capture tool) |
| Affinity (Canva-owned, now free) | CAD $0 | Future-maybe for advanced design |
| Moneris | Transaction-fee based; Interac debit ~CAD $0.10, credit-card % fees | Add only after accounting/payment policy is approved |
| FinanceIT | Dealer fee / financing economics vary by program | Add only after customer wording and dealer economics are approved |
| WooCommerce/hosting | CAD ~$35/mo planning note | Deferred; not needed for Task 1 |

## Payment Stack To Validate

| Method | Cost Position | Task 1 Decision |
|---|---|---|
| Cash / cheque / draft / direct deposit | Lowest processing cost | Allowed if office/accounting approves wording and tracking |
| Interac e-Transfer | Low or no processing cost depending bank setup | Preferred low-cost customer payment path if operationally accepted |
| Moneris Interac debit | Per-transaction fee based | Approval required; only if in-person/card terminal process is needed |
| Moneris credit card | Percentage fee based | Offer only with approved fee policy and QuickBooks/payment reconciliation |
| FinanceIT | Financing/dealer economics | Offer only after approved program, scripts, and compliance wording |

Payment methods should appear in customer-facing proposals only after the owner
and accounting confirm wording, fees, reconciliation, and staff handling.

## Free / Minimum Options

| Need | Free Or Minimum | Low-Cost Paid | Deferred Purchase |
|---|---|---|---|
| Owned data store | Cloudflare D1 + R2 + Pages free tier (~$0) | Cloudflare paid tiers at volume | Custom relational store |
| Storage | Cloudflare R2 / existing OneDrive | Workspace/Microsoft paid storage if capacity requires | Custom object storage |
| OCR | AppliCad XML, PDF text extraction, Cloudflare `toMarkdown()` (free Workers AI binding, replaces standalone Tesseract for text PDFs) | Mistral OCR (~$2-$4 per 1,000 pages) only for image-heavy/scanned/handwritten/layout-sensitive docs | Google Document AI if preferred (do NOT self-host an OCR engine — needs a GPU box) |
| LLM drafting | Manual templates or de-identified prompts | Cheap models for non-sensitive text; Claude when structured field extraction/reasoning is needed | Dedicated paid LLM/vendor with privacy review |
| E-sign | JobNimbus native e-sign / HTML+PDF | DocuSeal (OSS; managed Cloud ~CAD $30/mo or one self-hosted container) | PandaDoc/DocuSign (retired — DocuSeal is the escape hatch) |
| Automation | Existing Make scenarios (on Core) | Make Core covers dead-letter/dedup/reconcile at this volume; or the Cloudflare Workers bus | Custom relay |
| Booking | JobNimbus calendar via Make webhook | Cal.com fallback | Custom booking page |
| Field photos/geo | Jotform "Jobsite Photo" form ($0 incremental; device GPS at submit, offline-capable) | Improve the Jotform flow (kiosk mode, simpler/auto job-picker) if crew capture friction appears | Self-hosted OSS photo server / custom PWA (rejected) |
| Dashboard | JobNimbus reports + sheet + owned D1 view | Looker Studio/small page | Full custom dashboard |
| Local lead trust | Google Business Profile | JobNimbus review automation → GBP review link via ESP/Engage | Local SEO/ads agency |
| Paid local leads | No spend until intake QA | Google Local Services Ads if eligible | Google Ads/agency |
| Design tooling | Free Canva + free Affinity (Designer/Photo/Publisher, now 100% free) | Canva Pro (~CAD $18/mo) only if brand-kit/background-remover/team features needed | Standalone Acrobat Pro (future-maybe); Adobe Creative Cloud rejected |

## Data And Privacy Constraint For Cheap AI

Free/cheap LLM providers are allowed only for:

- De-identified drafting.
- Internal SOP generation.
- Template text.
- Non-customer examples.

Do not send customer names, phone numbers, addresses, job details, recordings,
payment status, or documents to a free/cheap AI provider until vendor terms,
privacy notice, and owner approval are complete. Disclose cross-border (US
processor) handling with DPAs/ZDR (see 09-security-privacy-compliance.md).

## Source URLs To Re-Check Before Purchase

- JobNimbus: https://www.jobnimbus.com/pricing
- JobNimbus Engage: https://www.jobnimbus.com/features/engage/
- JobNimbus AssistAI: https://www.jobnimbus.com/features/
- Make: https://www.make.com/en/pricing
- Twilio (numbers/voice/SMS): https://www.twilio.com/en-us/pricing
- Retell: https://www.retellai.com/pricing
- Jotform: https://www.jotform.com/pricing/
- Canva: https://www.canva.com/pricing/
- Cloudflare D1: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Pages: https://developers.cloudflare.com/pages/functions/pricing/
- Cloudflare Workers: https://developers.cloudflare.com/workers/platform/pricing/
- Mistral OCR: https://docs.mistral.ai/models/model-cards/ocr-4-0
- Claude (API pricing, native PDF read): https://www.anthropic.com/pricing
- Google Business Profile guidelines: https://support.google.com/business/answer/3038177
- Google Local Services Ads Canada: https://business.google.com/ca-en/ad-solutions/local-service-ads/
- CallRail pricing: https://www.callrail.com/pricing
- A2P 10DLC (carrier registration): https://www.twilio.com/en-us/guidelines/a2p-10dlc
