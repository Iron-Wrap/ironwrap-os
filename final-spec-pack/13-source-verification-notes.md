# 13 - Source Verification Notes

Date checked: 2026-06-27

> Historical research notes. Current stack decisions are in `00-final-decisions.md`;
> do not treat older Moneris/ESP/OneDrive notes here as implementation instructions.

These notes capture the source checks used while finalizing this pack. Pricing
and vendor features change often, so re-check before purchase or production
contracting.

## Compliance Sources

| Source | URL | Check Result |
|---|---|---|
| OPC Canada PIPEDA principles | https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/ | HTTP 200 |
| Alberta PIPA | https://www.alberta.ca/personal-information-protection-act | HTTP 200 |
| CRTC CASL guide | https://crtc.gc.ca/eng/com500/guide.htm | HTTP 200 |
| National DNCL | https://lnnte-dncl.gc.ca/en | HTTP 200 |

Compliance interpretation in this pack:

- Build is compliant-by-design, not lawyer-certified.
- Production launch is blocked until consent, AI/call recording notice, unsubscribe handling, DNCL/internal DNC, vendor register, retention, breach response, and access hardening are approved.

## Vendor And Pricing Sources

| Source | URL | Check Result |
|---|---|---|
| GHL pricing | https://www.gohighlevel.com/pricing | HTTP 200 |
| Make pricing | https://www.make.com/en/pricing | HTTP 403 to CLI check; verify in browser before purchase |
| Vapi pricing | https://vapi.ai/pricing | HTTP 200 |
| Retell pricing | https://www.retellai.com/pricing | HTTP 200 |
| ElevenLabs agents pricing | https://elevenlabs.io/pricing/agents | HTTP 200 |
| Mistral OCR 4 model/pricing | https://docs.mistral.ai/models/model-cards/ocr-4-0 | HTTP 200 |
| NaturalForms main site | https://naturalforms.com/ | HTTP 200 |
| NaturalForms pricing | https://naturalforms.com/pricing | HTTP 200 |
| NaturalForms REST API | https://naturalforms.com/integrations/rest-api | HTTP 200 |
| NaturalForms Web Apps overview | https://support.naturalformsapp.com/hc/en-us/articles/115007125367-Web-Apps-Overview | HTTP 200 |
| NaturalForms JobNimbus partner page | https://naturalforms.com/partners/jobnimbus | HTTP 200 |

The GHL and Vapi pricing rows are declined/excluded vendors, kept for provenance only.

## Make Current-State Audit (2026-06-28)

As of 2026-06-28 the experimental GHL-based Make setup (org "IronWrap
Exteriors", Make Core plan, team "My Team", ~16 scenarios) already contains, on
the experimental GHL hub: a live RoofRuler report intake (Make AI Extract +
OneDrive), Google Drive folder automation keyed by lead/job number, GHL->JobNimbus
import scenarios (the in-progress cutover; note `record_type_name` must be an
account-valid value — contact `Customer`, job `Retail`; `"Lead"` is rejected
400), a Jotform "Completion Form" workflow (scaffolded, inactive), and inactive
Facebook Lead Ads scenarios. JobNimbus and Jotform are already connected in
Make. These are experimental on GHL; Task 1 migrates/rebuilds the keep-worthy
ones onto the JobNimbus spine + owned bus, then retires GHL.

## Local Assumptions Carried From Existing v9.1 Notes

Use these only as planning numbers until vendor quotes are confirmed:

- Renoworks: CAD $8,000 setup + USD $3,200/year.
- Paradigm: CAD $10,800 setup + CAD ~$673/month.
- NaturalForms: CAD ~$21/user/month.
- RoofRuler: CAD ~$40/report.
- Google Workspace: CAD ~$60/month for 3 users.
- AI receptionist: CAD ~$100/month plus CAD ~$300 setup in existing v9.1 planning notes.
- Moneris: transaction-fee based; v9.1 notes referenced low fixed Interac debit fees and percentage-based credit-card fees.
- FinanceIT: dealer/program economics vary; treat as approval-gated, not automatic.
- WooCommerce/hosting: CAD ~$35/month planning note, deferred from Task 1.

## NaturalForms Verification Notes

> Superseded 2026-06-28: NaturalForms is DROPPED (stagnant). Field photos/geo now
> default to a Jotform "Jobsite Photo" form (JobNimbus job picker + Geolocation
> widget capturing device GPS at submit, coordinates-only, offline-capable) and
> structured forms to Jotform; see 00/02/15. The notes below are the original
> point-in-time verification record, kept for provenance.

NaturalForms was originally slated for the first deliverable because IronWrap
already has a subscription.

Verified public details:

- NaturalForms positions the product around smart forms, eSignatures, workflow automation, photo/sketch capture, offline mobility, Smart PDF transform, workflow logic, connectors, webhooks, and REST API.
- NaturalForms lists JobNimbus as an integration for syncing roofing jobs and form data.
- The JobNimbus partner page describes prefilled job/customer data, completed/signed document uploads to job folders, and photo/sketch sync.
- Pricing page lists Essentials, Advanced, and Grow. Advanced includes unlimited integrations; Grow lists full API access.
- Web Apps support docs state Output Settings support QuickBooks, Google Sheets, JobNimbus, and Generic Web Apps connectors, with document-data mapping and PDF/CSV/JSON/XML data-file links through webhook output.
- REST API page shows completed document querying and describes CRUD access for users, documents, and templates, OAuth 2.0/API-key authentication, and bulk data extraction.

Implementation interpretation SUPERSEDED 2026-06-28 — NaturalForms is dropped; field photos/geo now default to the Jotform "Jobsite Photo" form (see 00/02/15). The verified facts above are kept for provenance only.

## Existing v9.1 Details Audited Into Final Pack

- The repo PDFs are treated as real RoofRuler reports delivered automatically by email.
- The 18% close-rate and lost-lead risk are represented as business context, not as guaranteed current performance.
- The 60 RoofRuler reports/month assumption is treated as expansion/volume proof, not Task 1 budget truth.
- All 12 recurring forms/documents from v9.1 are represented in the workflow library.
- The payment stack includes cash/cheque/direct deposit, Interac, Moneris, credit card, and FinanceIT validation gates.
- Renoworks is represented as optional lead-intent and proposal visualization, with setup, mapping, and privacy checks.
- Paradigm is represented as a deferred shop/material bridge, including rollformer/import checks.
- WooCommerce/B2C store and Calgary expansion are explicitly deferred unless owner adds them to Task 1.
- The separate sellable metal-layout SaaS idea is excluded from this pack because Task 1 is the current scope.

## Final Pricing Position

Present the existing-subscription first deliverable first:

- First-deliverable incremental: ~CAD $120-220/mo (loaded, incl. ~1.40 FX + GST).
  The driver is JobNimbus Engage (~CAD $90-140 loaded with SMS usage); the rest is
  small — Twilio DID + usage (~CAD $5-30), the A2P monthly campaign fee (~CAD $5-15),
  and the bus on Cloudflare Workers (~CAD $20-30) if heavy steps move off Make.
  Make is on the Core plan (already subscribed, $0 incremental — no tier bump).
  Cloudflare
  D1/R2/Workers ≈ $0, the ESP ≈ $0 (Resend's free tier likely covers low volume),
  design = $0 (free Canva + free Affinity). AssistAI minutes are a Phase-2
  (post-eval) cost (~CAD $35-70 loaded when live), not part of the first-deliverable
  incremental.
- One-time setup ~CAD $700-2,100 (A2P registration, DID provisioning, Make/Workers
  bus build labor, ESP domain auth, form re-pointing, training). "$0 new vendor
  setup" is false — Cloudflare, the ESP, the owned Twilio number, and (if adopted)
  DocuSeal are new vendor lines. GHL was never adopted, so this still avoids
  ~CAD $135-415/mo of GHL cost; frame as "simpler, more portable, avoids GHL's
  cost," not a dramatic saving.
- CAD $1,100-$2,500/month remains the all-in planning run-rate if the existing
  subscriptions are re-priced from zero — the all-in figure, NOT the incremental.

Treat the larger CAD $4,200-$5,800/month scenario as expansion after volume
proof, not Task 1.
