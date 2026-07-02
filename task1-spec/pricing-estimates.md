# Task 1 Pricing And Cost Scenarios

Date: 2026-06-27

All prices are estimates for IronWrap Task 1. Pricing must be re-checked before
purchase because SaaS, telephony, AI, and API pricing changes often.

Currency assumptions:

- USD to CAD planning rate: `1 USD = 1.42 CAD`.
- USD prices are converted only for budgeting.
- Taxes, card fees, implementation services, and vendor-negotiated discounts are excluded unless noted.

## Bottom Line

Best option for Task 1 at current low lead volume:

- Keep `JobNimbus` as job CRM.
- Keep `GHL` as lead, booking, SMS, nurture, reviews, and missed-call/after-hours
  AI pilot first.
- Keep `Make`; add custom gateway/audit only where Make logs, retries, or
  dedupe are insufficient.
- Use `QuickBooks` only for accounting.
- Use one storage provider only: Google Drive or OneDrive, not both.
- Use deterministic extraction first, then `Mistral OCR 4` as a fallback.
- Defer `Paradigm` until materials/shop flow is proven.
- Add `NaturalForms` only if JobNimbus mobile/forms fail field reality.
- Add `Renoworks` only if IronWrap deliberately uses website/proposal
  visualization as a sales channel.
- Buy RoofRuler/reporting per qualified job; do not budget 60 reports/month
  until current sales volume proves it.

Expected vendor run-rate:

- Low-volume operating spine, excluding Renoworks/Paradigm/NaturalForms and
  bulk RoofRuler volume: about `CAD $1,100-$2,500/mo` all-in vendor run-rate,
  depending mostly on JobNimbus and GHL plans.
- If JobNimbus/GHL/Make/QuickBooks are already paid, likely new incremental
  spend during build/config/test is closer to `CAD $50-$400/mo`.
- Recommended sales stack with proven RoofRuler volume + Renoworks: about `CAD $4,200-$5,800/mo`.
- Full v9.1-style stack with NaturalForms + Paradigm: about `CAD $5,000-$6,800/mo`, plus about `CAD $18,800+` in known setup fees from local v9.1 assumptions.

## Scenario Totals

| Scenario | Monthly estimate | One-time estimate | What it includes | Recommendation |
|---|---:|---:|---|---|
| Low-volume operating spine | `CAD $1,100-$2,500` all-in, or `CAD $50-$400` incremental if existing subscriptions stay | `CAD $0-$500` | JobNimbus cleanup, GHL intake/booking/SMS/reviews, Make audit, one storage authority, QuickBooks visibility, OCR fallback, simple exceptions view | Best immediate target |
| Lean build/test | `CAD $1,400-$2,800` | `CAD $0-$2,000` | Low-volume spine + GHL AI pilot, small audit/gateway if needed, proposal/parser work | Use only for active build/config/test |
| Recommended production after volume proof | `CAD $4,200-$5,800` | `CAD $8,000-$12,000` | Lean + proven RoofRuler volume + Renoworks + optional NaturalForms pilot | Later expansion target |
| Full v9.1 stack | `CAD $5,000-$6,800` | `CAD $18,800+` | Recommended + Paradigm setup/monthly + fuller field/shop stack | Do later, not first |
| Full-control custom voice | Recommended + `CAD $100-$800` | `CAD $1,000-$5,000` | Replace GHL Voice AI with Vapi/ElevenLabs/Retell/Twilio/LiveKit path | Only if GHL fails evals |

## Core Stack Pricing

| Tool | Current public/vendor pricing | Planning estimate | Notes |
|---|---:|---:|---|
| JobNimbus | Quote-based. Official pricing page does not list fixed public prices; cost depends on plan, users, and add-ons. | `CAD $600-$1,500/mo` | Existing account is underconfigured. Must get itemized quote for CRM base, user roles, Engage/Marketing/Payments/add-ons. |
| GHL base plan | Starter `$97/mo`, Unlimited `$297/mo`, Agency Pro `$497/mo`, USD. | `CAD $422/mo` for Unlimited | Unlimited is the practical default if API/subaccounts/rebilling matter. Starter may be enough only if IronWrap is one location and API limits are acceptable. |
| GHL AI Employee | Growth `$50/mo/location`; Unlimited `$97/mo/location`, USD. Phone system charges still apply. | `CAD $138/mo` for Unlimited | Best first AI receptionist test because GHL already owns lead/booking/SMS. |
| GHL telephony/SMS/email usage | Usage-based. AI page says phone system charges still apply. | `CAD $50-$250/mo` | Depends on call minutes, SMS volume, email volume, phone numbers. |
| Make | Free 1,000 credits. Core `$12/mo`, Pro `$21/mo`, Teams `$38/mo` for 10k credits, USD. | `CAD $30-$150/mo` | Use Pro/Teams for logs/search/roles; higher credits if scenarios grow. |
| QuickBooks Online Canada | Official pricing is dynamic by region/promo. | `CAD $80-$200/mo` | Use Plus/Advanced-level budget if projects, custom roles, or stronger finance controls are needed. Verify in Canadian account before buying. |
| Google Workspace or Microsoft 365 | Local v9.1 assumed Google Workspace Business Standard about `CAD $60/mo` for 3 users. | `CAD $60-$100/mo` | Pick one suite/storage authority. Do not run Google Drive and OneDrive as equal archives. |
| Cloudflare Workers | Free, or Paid starts at `$5/mo` USD. | `CAD $7-$25/mo` | Good for webhook relay, audit API, health checks. |
| Supabase or Neon Postgres | Supabase Pro starts at `$25/mo` USD; Neon has free/paid tiers. | `CAD $0-$75/mo` | Audit ledger and dashboard read model. Free is fine for test, paid for production. |
| Mistral OCR 4 | `$4 / 1,000 pages`, `$5 / 1,000 annotated pages`, USD. | `CAD $5-$50/mo` | OCR cost is tiny unless processing large archives. Use local parsing first. |
| Proposal PDF generation | Playwright/self-hosted: no vendor fee. | `CAD $0-$25/mo` | Runs inside existing gateway/worker infra. |

## Voice / AI Receptionist Alternatives

Planning assumption for comparison: `500 AI call minutes/month`.

| Provider | Public pricing | 500-min planning cost | Notes |
|---|---:|---:|---|
| GHL Voice AI | AI Employee Unlimited `$97/mo/location` plus phone charges, USD. Pay-per-use formula uses voice engine, TTS, LLM, phone charges. | `CAD $190-$390/mo` all-in estimate | Test first. Best CRM/calendar fit if call quality and tool behavior pass. |
| Vapi | Calls `$0.05/min` hosting, model provider costs passed through, 10 concurrency included then `$10/line/mo`, USD. | `CAD $70-$250/mo` plus telephony/model variance | Best managed fallback because it has GHL tools. |
| ElevenLabs ElevenAgents | Pro `$99/mo` includes 1,238 call minutes; additional calls `$0.08/min`; LLM and telephony extra, USD. | `CAD $170-$300/mo` | Strong voice quality. Test after GHL/Vapi if voice quality is the issue. |
| Retell | Pay-as-you-go `$0.07-$0.31/min`; typical calculator example `$0.11/min`, USD. | `CAD $78-$220/mo` | Solid QA/transcript/call ops. |
| Bland | Start free at `$0.14/min`; Build `$299/mo + $0.12/min`; Scale `$499/mo + $0.11/min`, USD. | `CAD $99/mo` on Start, or `CAD $510+/mo` on Build | Benchmark only unless it wins evals. |
| Telnyx Voice AI | Conversational AI `$0.05/min`; Call Control `$0.002/min`; STT/Telnyx TTS included; LLM and telephony vary, USD. | `CAD $50-$180/mo` | Good if replacing telephony stack. |
| Twilio + OpenAI Realtime | Twilio Canada voice + OpenAI realtime audio tokens. OpenAI `gpt-realtime-2` audio is `$32/M input`, `$64/M output` tokens. | `CAD $150-$800/mo` | Most control, most engineering. Do only if managed providers fail. |
| LiveKit Agents | LiveKit pricing varies by hosted/self-hosted usage; SIP/telephony extra. | `CAD $100-$800/mo` | Last resort for owning realtime voice infra. |

Voice recommendation:

1. Test GHL Voice AI first.
2. If GHL fails booking/tool-call behavior, test Vapi.
3. If Vapi works but voice quality is weaker, test ElevenLabs.
4. Retell/Bland/Telnyx are benchmark options, not first build choices.
5. Twilio/OpenAI or LiveKit are custom builds only after a specific managed-platform failure is proven.

## Sales / Visualization / Field / Shop Add-Ons

| Tool | Pricing known today | Planning estimate | Recommendation |
|---|---:|---:|---|
| RoofRuler | Local v9.1 assumption: `CAD $40/report`, `60 reports/mo = CAD $2,400/mo`. | `CAD $40 x qualified reports`; `CAD $2,400/mo` only at 60 reports | Pay per qualified job first. Forecast volume only after real usage. |
| Renoworks | Local v9.1 assumption: `CAD $8,000 setup + USD $3,200/year`. | `CAD $8,000 setup + CAD ~$378/mo` | Defer until website visualizer/proposal visualizer is a deliberate sales motion. |
| NaturalForms | Local v9.1 assumption: about `CAD $21/user/mo`. | `CAD $63-$210/mo` for 3-10 users | Pilot only if JobNimbus mobile/forms are insufficient. |
| Paradigm / Vendo | Local v9.1 assumption: `CAD $10,800 setup + CAD ~$673/mo`. | `CAD $10,800 setup + CAD $673/mo` | Defer until material request workflow is stable. |
| DocuSeal | Self-host option available; paid cloud/on-prem options vary. | `CAD $0-$100/mo` | Use only if JobNimbus signing/templates fail. |
| PandaDoc / DocuSign | Paid proposal/e-sign suites. | `CAD $50-$300+/mo` | Skip unless native/custom proposal path fails. |
| Moneris / payment processor | Transaction fees and payment plan vary. | `CAD $0-$100/mo + processing` | Validate directly. Avoid storing card/PAD data in CRM/AI logs. |
| Financeit | Dealer program/pricing varies. | `% per financed deal` | Validate dealer economics before adding to proposals. |

## Build Infrastructure Pricing

| Component | Preferred cheap option | Monthly estimate |
|---|---|---:|
| Webhook gateway | Cloudflare Workers Paid | `CAD $7-$25` |
| Audit ledger DB | Supabase/Neon Postgres | `CAD $0-$75` |
| Background parser/OCR worker | Workers, Railway, Render, Fly.io, or local scheduled job | `CAD $0-$50` |
| Proposal hosting | Existing website, Vercel/Netlify, or Cloudflare Pages | `CAD $0-$25` |
| Monitoring alerts | Make alerts + email/Slack + simple dashboard | `CAD $0-$50` |

## One-Time Setup Budget

| Item | Estimate |
|---|---:|
| Renoworks setup, if purchased | `CAD $8,000` from local v9.1 |
| Paradigm setup, if purchased | `CAD $10,800` from local v9.1 |
| Vendor onboarding/config fees | `CAD $0-$5,000` depending on quotes |
| Custom gateway/parser/proposal/dashboard build | Vendor cost: mostly infra above. Implementation labor not included here. |
| Security/access final hardening | Vendor cost: usually `CAD $0-$500`, unless SSO/enterprise plans are required |

## Recommended Budget To Present To IronWrap

Immediate low-volume build/config/test:

- Budget `CAD $1,100-$2,500/mo` all-in vendor run-rate.
- If existing subscriptions are already paid, expect only `CAD $50-$400/mo`
  in new incremental vendor spend until optional add-ons are approved.
- Do not buy Paradigm yet.
- Do not buy NaturalForms yet unless field tests fail.
- Do not buy Renoworks yet unless IronWrap commits to visualizer-led selling.
- Do not buy bulk RoofRuler/report volume; pay per qualified report.
- Do not buy an alternative AI voice platform until GHL missed-call/after-hours
  pilot fails scripted evals.

Production expansion if visualizer and report volume are proven:

- Budget `CAD $4,200-$5,800/mo`.
- One-time `CAD $8,000-$12,000` if Renoworks is purchased and configured.

Full future stack:

- Budget `CAD $5,000-$6,800/mo`.
- One-time known setup from v9.1 assumptions: `CAD $18,800+`.
- This includes Paradigm, but Paradigm should wait until material/shop workflow is proven.

## Source Notes

Public pricing sources checked:

- JobNimbus pricing is quote-based: https://www.jobnimbus.com/pricing
- HighLevel plans: https://www.gohighlevel.com/pricing
- HighLevel AI pricing: https://help.gohighlevel.com/support/solutions/articles/155000006652-ai-product-pricing
- Make pricing: https://www.make.com/en/pricing
- Vapi pricing: https://vapi.ai/pricing
- ElevenAgents pricing: https://elevenlabs.io/pricing/agents
- Retell pricing: https://www.retellai.com/pricing
- Bland billing: https://docs.bland.ai/platform/billing
- Telnyx Conversational AI pricing: https://telnyx.com/pricing/conversational-ai
- Twilio Canada voice pricing: https://www.twilio.com/en-us/voice/pricing/ca
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Supabase pricing: https://supabase.com/pricing
- n8n pricing: https://n8n.io/pricing/
- Cal.com pricing: https://cal.com/pricing
- Mistral OCR 4 pricing/model card: https://docs.mistral.ai/models/model-cards/ocr-4-0

Local v9.1 assumptions used where public pricing is quote-based or not listed:

- Renoworks: `CAD $8,000 setup + USD $3,200/year`.
- Paradigm: `CAD $10,800 setup + CAD ~$673/mo`.
- NaturalForms: `CAD ~$21/user/mo`.
- RoofRuler: `CAD ~$40/report`, `60 reports/mo = CAD $2,400/mo`.
- Google Workspace: `CAD ~$60/mo` for 3 users.
