# 17 - US Best-Practice Cross-Reference

Date: 2026-06-27

## Scope

This audit compares the IronWrap Task 1 pack against current US and Canada
home-services operating practices. It is a benchmark, not a pivot away from the
existing-stack plan.

IronWrap operates in Alberta, so US channel practices should be applied only
when the same tool, legal requirement, and ad category are available in Canada.

## Audit Result

The current pack is aligned with the practical best option for a low-volume
roofing/exteriors business:

- Keep JobNimbus as job truth and as the operational CRM / front door for
  leads, booking, SMS (JobNimbus Engage), reviews, and nurture instead of
  switching CRM.
- Treat Make as critical infra (the integration bus): leads normalize into a
  canonical envelope and dual-write to the owned data layer (Cloudflare D1+R2)
  FIRST, then JobNimbus, with dedup, error-handler -> dead-letter, and daily
  reconciliation.
- Use the Jotform "Jobsite Photo" form as the sole jobsite-photo/geo tool
  (JobNimbus job picker + Geolocation widget capturing device GPS at submit,
  coordinates-only, offline; webhook -> Make -> Google Drive + JobNimbus + owned
  store). Add Jotform for any other workflow that needs a structured form.
- Use Google Drive (Google Workspace) as archive storage.
- Use QuickBooks as accounting truth.
- Start the phone AI with native JobNimbus AssistAI (eval-gated); fall back to
  managed Retell only if it fails the gate. Expand only after reviewed calls
  pass.
- Improve website funnel attribution before spending more on ads.
- Use free/low-cost extraction first and reserve Mistral OCR 4 for difficult
  reports.

The main correction from this audit is that Google Business Profile, Local
Services Ads readiness, UTM/source attribution, and call-source tracking should
be explicit in Task 1. They do not require a new expensive tool first.
Attribution is deferred to UTM + manual Lead Source + one tracked number;
CallRail is added only when paid ads start. (GHL is declined as keeper: it is
not the future lead/booking/phone/SMS/review/nurture layer.)

## Best-Practice Cross-Reference

| Current Best Practice | Evidence | IronWrap Pack Status | Correction |
|---|---|---|---|
| Fast response beats more lead spend | Lead-response research continues to emphasize minutes, not hours, especially for website and phone leads. | Covered: instant-response / missed-call-text-back (MCTB) is the headline, plus JobNimbus intake, AssistAI, follow-up, owner exceptions | Add response-time field/reporting to owner exceptions |
| Preserve source and intent | UTM capture on the website plus a manual Lead Source field and one tracked number preserve first-touch attribution; call tracking can map numbers to pages/campaigns later. | Covered in integrated website-funnel edits and the website-funnels chapter (file 16) | Add explicit UTM, landing page, and call source fields |
| Google Business Profile matters for service-area businesses | Google requires accurate address/service-area setup and limits service-area definitions to specific cities/postal areas rather than arbitrary radius. | Undercovered | Add GBP audit and review-link check |
| Local Services Ads are pay-per-lead, not pay-per-click | Google Local Services Ads in Canada include roofing and siding categories in the current Google pages, but eligibility must be checked by area/category. | Not a first-deliverable purchase | Add LSA readiness gate after attribution and response-time QA |
| Call attribution should be solved before paid traffic | Attribution is deferred: UTM + manual Lead Source + one tracked number cover first-touch until spend starts; CallRail is the paid add-on once paid ads run. | Partially covered | Defer attribution to UTM + Lead Source + one tracked number; add CallRail only when paid ads start |
| Reviews must be operational, not manual | Google/LSA trust and conversion depend heavily on current profile quality and review discipline. | Covered through the JobNimbus review flow | Add GBP review link/source routing to QA |
| Field evidence should come from mobile forms | The Jotform "Jobsite Photo" form (JobNimbus job picker + Geolocation widget capturing device GPS at submit, coordinates-only, offline) captures photos/geo and syncs via webhook -> Make -> Google Drive + JobNimbus + owned store. | Covered | No change |
| CRM replacement is not the first move | JobNimbus, ServiceTitan, AccuLynx, Housecall Pro, and Jobber all cover overlapping contractor workflows, but switching destroys momentum when JobNimbus already exists. | Covered | Keep switch-review as future-only, not Task 1 |
| OCR should be gated by document type | Mistral OCR 4 is current and strong for structured OCR, but AppliCad XML and text PDFs are cheaper and more deterministic. | Covered | Keep OCR 4 as fallback, not default |

## Best Options As Of This Audit

| Need | Best First Option | Cheap / Free Option | Paid Fallback | Decision |
|---|---|---|---|---|
| CRM/job truth | JobNimbus | Existing account | ServiceTitan, AccuLynx, Housecall Pro, Jobber | Keep JobNimbus |
| Lead capture and nurture | JobNimbus + JobNimbus Engage (SMS) + Google Workspace brand mailboxes (SPF/DKIM/DMARC); dedicated ESP deferred | Existing account | Dedicated transactional ESP for bulk | Keep JobNimbus as the front door |
| Integration bus | Make (canonical envelope, dedup, dead-letter, reconciliation; dual-write owned D1+R2 FIRST, then JobNimbus) | Existing account (Make Core, no tier bump) | Custom middleware | Treat Make as critical infra |
| Call tracking | UTM + manual Lead Source + one tracked number | Page/source fields and manual source checks | CallRail Lead Tracking | Defer; add CallRail only when paid ads start |
| Phone AI | JobNimbus AssistAI (eval-gated) | Missed-call/after-hours only | Managed Retell, then managed-OSS (LiveKit Cloud / Pipecat Cloud) as "tier 2.5" if both fail the eval (4-vendor DIY stack stays killed) | AssistAI → managed Retell → managed-OSS tier 2.5; Google Voice is unusable (don't conflate with Gemini Live API) |
| Website funnels | Existing site pages/forms | Hidden fields, source URL, service intent, UTM capture | Landing page rebuild, ads agency | Fix routing/attribution first |
| Local organic trust | Google Business Profile | Free GBP audit, photos, categories, service areas, review link | Local SEO agency | Add Task 1 checklist |
| Paid local leads | Local Services Ads if eligible | No spend until tracking works | Google Ads / agency / LSA manager | Gate until response-time QA passes |
| Field photos/geo | Jotform "Jobsite Photo" form (job picker + Geolocation widget) | Existing Jotform subscription | Commercial e-sign API or owned signing for signature-grade docs, after the JobNimbus native e-sign bridge (DocuSeal retired, AGPL) | Sole jobsite-photo/geo tool; do not rely on EXIF |
| Structured forms | Jotform when a workflow needs it | Existing Jotform subscription | JobNimbus native e-sign (bridge) → commercial e-sign API or owned signing; Adobe dev API for structured capture | Add per workflow; DocuSeal retired permanently (AGPL) |
| Design tooling | Free Canva + free Affinity (Affinity went 100% free Oct 2025) | Existing subscription | Canva Pro (~CAD $18/mo) only if brand-kit/team features needed; full Adobe Creative Cloud rejected | Free Canva + free Affinity |
| Document extraction | AppliCad XML + PDF text | Cloudflare `toMarkdown()` (Workers AI binding — free, on-stack, text PDFs/DOCX → clean Markdown) as the free first pass; manual review | Mistral OCR 4 (image-heavy/scanned only) | XML/text first → toMarkdown() free pass → LLM/OCR only when needed |
| Archive storage | Google Drive (Google Workspace) | Existing account | — | Google Drive (Google Workspace) is the storage authority; owned raw store stays Cloudflare R2 |
| Outbound email | Google Workspace brand mailboxes (SPF/DKIM/DMARC) | Existing account | Dedicated transactional ESP, deferred for bulk | Google Workspace brand mailboxes; dedicated ESP deferred |
| Dashboard | JobNimbus reports + exception sheet | Google Sheet/Looker Studio | Custom dashboard | Keep lean |

## Funnel Corrections

Add these to the first deliverable:

1. Confirm website forms capture `source_url`, `landing_page`, `page_type`,
   `service_intent`, `utm_source`, `utm_medium`, `utm_campaign`,
   `utm_content`, `utm_term`, and call source when available.
2. Track first response time from form/call creation to first real reply.
3. Add Google Business Profile review link and source label to the review flow.
4. Add a Google Business Profile audit checklist: categories, service areas,
   business hours, phone, website URL, photos, services, reviews, and booking
   link if used.
5. Prepare Local Services Ads readiness, but do not spend until UTM + manual
   Lead Source + tracked-number attribution works, call source tracking works,
   Phone/SMS response SLA is tested, duplicate prevention works, and staff can
   handle added lead volume.

## Do Not Do Now

- Do not rebuild the website before testing current forms and source capture.
- Do not switch from JobNimbus while the existing stack is still unconfigured.
- Do not buy CallRail before paid ads start; UTM + manual Lead Source + one
  tracked number is the deferred attribution path until then.
- Do not start Local Services Ads or heavier paid campaigns before response
  time, source tracking, dedupe, and owner exceptions pass QA.
- Do not use Mistral OCR 4 for every report when XML or text extraction already
  provides reliable data.
- Do not add ServiceTitan, AccuLynx, Housecall Pro, or Jobber as replacement
  platforms in Task 1.

## Source Notes

Sources checked on 2026-06-27:

- Google Business Profile guidelines:
  https://support.google.com/business/answer/3038177
- Google Business Profile service-area management:
  https://support.google.com/business/answer/9157481
- Google Local Services Ads Canada:
  https://business.google.com/ca-en/ad-solutions/local-service-ads/
- Google Local Services Ads Canada help:
  https://support.google.com/localservices/answer/6224841?co=GENIE.CountryCode%3DCA
- Google Local Services Ads lead billing:
  https://support.google.com/localservices/answer/7195435
- Workato 2026 lead-response benchmark:
  https://www.workato.com/the-connector/lead-response-time-study/
- MIT / InsideSales lead-response management study:
  https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf
- JobNimbus Engage (two-way SMS):
  https://www.jobnimbus.com/features/engage/
- JobNimbus AssistAI (AI phone receptionist):
  https://www.jobnimbus.com/features/
- Make (integration bus) pricing:
  https://www.make.com/en/pricing
- Managed Retell (phone-AI fallback) pricing:
  https://www.retellai.com/pricing
- A2P 10DLC + Canadian carrier registration:
  https://www.twilio.com/en-us/guidelines/a2p-10dlc
- Roofing CRM/software market references:
  https://www.jobnimbus.com/industries/roofing-software
  https://www.servicetitan.com/industries/roofing-software
  https://acculynx.com/
  https://www.housecallpro.com/industries/roofing-software/
  https://www.getjobber.com/industries/roofing-software/
- Jotform "Jobsite Photo" form (forms + Geolocation widget):
  https://www.jotform.com/pricing/
- Canva / Affinity (design tooling):
  https://www.canva.com/pricing/
- Owned data layer (Cloudflare D1 + R2):
  https://developers.cloudflare.com/d1/platform/pricing/
  https://developers.cloudflare.com/r2/pricing/
- CallRail pricing and attribution:
  https://www.callrail.com/pricing
  https://www.callrail.com/call-tracking/attribution
- Mistral OCR 4:
  https://mistral.ai/news/ocr-4/
  https://mistral.ai/pricing/
