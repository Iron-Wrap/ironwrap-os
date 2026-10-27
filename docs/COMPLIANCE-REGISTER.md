# Compliance Register

Status: canonical control index, not legal advice
Owner: IronWrap compliance owner
Last source verification: 2026-07-30
Review events: provider-terms-change, provider-added, production-release
Last review: provider-added (AI model providers section)
Immediate review trigger: changed law, regulator guidance, geography, service, contract, workforce,
vehicle, facility, product, marketing channel, or data use

## Use

This register identifies current control triggers for an Edmonton, Alberta exterior contractor and
metal-fabrication shop. It does not decide the legal result for a particular job.

For every triggered row, the system must:

1. identify the exact legal entity, property, jurisdiction, work, worker, vehicle, customer,
   channel, or data processing;
2. retrieve the current authoritative rule;
3. record applicability, reviewer, effective version, evidence, and expiry/recheck;
4. obtain the named human/external signoff where law or competent judgment requires it;
5. block the affected transition when authority or evidence is missing.

The legal effect of a contract, permit, lien, holdback, tax position, privacy event, employment
classification, or trade activity must be confirmed by qualified counsel, accountant, regulator,
Safety Codes Officer, safety professional, or trade authority as appropriate.

## Business, facility, and municipal authority

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Conducting business in Edmonton | Valid business licence for the legal entity, address, and all actual categories | City approval | [Apply for a business licence](https://www.edmonton.ca/business_economy/licences_permits/apply-for-a-business-licence) |
| Construction, fabrication, and counter sale | Map activities to Construction/Contracting/Labour, Manufacturer, retail, or other City classifications; do not infer one licence covers all | City classification decision | [Business licence classifications](https://www.edmonton.ca/business_economy/licences_permits/business-licence-classifications) |
| New/changed shop use or renovation | Zoning/development/building/fire status before occupancy or changed operation | City/Safety Codes/fire authority | [Changes to existing buildings](https://www.edmonton.ca/business_economy/changes-to-existing-buildings) |
| Residential improvement | Determine development/building/trade permit and inspection per exact scope | City/Safety Codes Officer | [Home improvement permits](https://www.edmonton.ca/residential_neighbourhoods/residential-construction) |
| Commercial/multi-unit work | Determine building/trade permits, GC relationship, and inspections; a like-for-like example is not a blanket exemption | City/Safety Codes Officer | [Commercial trade permits](https://www.edmonton.ca/business_economy/commercial-safety-codes-inspections) |
| Road, alley, sidewalk, lane, bin, crane, or public-right-of-way occupation | OSCAM/traffic/pedestrian plan and active permit before occupation | City permit | [OSCAM permit request](https://www.edmonton.ca/business_economy/oscam-permit-request) |
| Building/fire design or shop operation | Freeze applicable Alberta code edition and referenced standards on job/facility | Permit authority, engineer where required | [Alberta building codes and standards](https://www.alberta.ca/building-codes-and-standards) |

Current code note: Alberta identifies the National Building Code 2023 Alberta Edition and National
Fire Code 2023 Alberta Edition as in force from May 1, 2024. The system must still recheck the
applicable edition and local conditions for the exact permit.

## Residential consumer contracting

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Soliciting, negotiating, or concluding private-dwelling work away from the seller's place of business and taking money before all work is complete | Applicability decision before proposal/deposit; valid licence/security; approved contract form; salesperson ID; record retention | Alberta licence and lawyer-approved workflow | [Prepaid contracting licence](https://www.alberta.ca/prepaid-contracting-licence) |
| Qualifying prepaid/direct sales contract | Cancellation notice/window, immutable delivery proof, cancellation intake, stop-work/refund timer | Lawyer-approved contract; customer decision | [Consumer Bill of Rights](https://www.alberta.ca/consumer-bill-of-rights) |
| Home-improvement contract | Detailed work/material, subcontracted work, permit responsibility, schedule, debris, guarantees, payment, cancellation, dispute, and written change control | Customer signature and legal review | [Hiring a contractor](https://www.alberta.ca/hiring-contractor) |
| Prepaid-contract records | Retain required records for at least the official period; current licensing page states three years | Compliance owner | [Prepaid contracting licence](https://www.alberta.ca/prepaid-contracting-licence) |

Regulatory-change note: Alberta opened a 2026 engagement on consolidating direct-selling and
prepaid-contracting licensing. Recheck before changing contracts or automation. See
[Direct selling and prepaid contracting engagement](https://www.alberta.ca/direct-selling-and-prepaid-contracting-engagement).

## Occupational health and safety

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Any work activity | Hazard assessment before work, worker participation, controls, changed-condition reassessment | Competent supervisor/worker | [Hazard assessment, elimination and control](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-2-hazard-assessment-elimination-and-control/) |
| Fall exposure | Determine protection at 3 m and other hazardous lower-height cases; site plan when required; anchors, clearance, equipment, inspection, training, rescue, and review | Competent supervisor; engineer where required | [Fall protection](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-9-fall-protection/) |
| Multiple employers at a construction work site | Determine owner/prime-contractor duties, written designation/posting, cooperation, and system | Owner/prime contractor/legal review for applicability | [Work-site party obligations](https://www.alberta.ca/obligations-work-site-parties) |
| Worker alone or isolated | Hazard assessment, effective communication/check-in, assistance response | Supervisor | [Working alone](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-28-working-alone/) |
| Workers at site/shop | First-aid assessment, supplies, trained personnel, transportation/communication, records | Competent first-aid/safety owner | [First aid](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-11-first-aid/) |
| Forklift/lift/powered mobile equipment | Authorized competent operator, pre-use/periodic inspection, maintenance record, pedestrian separation, safe defect handling | Competent operator/supervisor | [Powered mobile equipment](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-19-powered-mobile-equipment/) |
| Shear, brake, roll former, slitter, press, saw, or other machine | Guarding/safeguards, access control, manufacturer limits, inspection | Competent machine/safety owner | [Safeguards](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-22-safeguards) |
| Setup, clearing, adjustment, inspection, or service with hazardous energy | Stop, isolate, secure, verify, personal/group control, controlled return to service | Authorized competent person | [Managing hazardous energy](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-15-managing-the-control-of-hazardous-energy/) |
| Welding, cutting, grinding, fuel/gas, hot work, or flammable atmosphere | Hazard assessment, permit where policy requires, ignition control, ventilation, cylinders, fire watch/extinguisher | Competent hot-work/fire owner | [Fire and explosion hazards](https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-10-fire-and-explosion-hazards/) |
| Serious injury, hospitalization, fatality, explosion, fire, flood, or other reportable event | Make safe, emergency response, preserve scene/evidence, notify OHS as soon as required, investigate, retain record | Emergency services/OHS/legal/safety owner | [Report serious injuries and incidents](https://www.alberta.ca/report-serious-injuries-incident) |
| Heat, cold, wind, lightning, smoke, ice, or storm | Job/system/equipment-specific stop criteria, monitoring, shelter, hydration/warming, reschedule | Site supervisor and worker stop authority | [Working in extreme temperatures](https://www.alberta.ca/working-extreme-temperatures) |
| COR participation | Audit calendar, corrective action, certificate status, change notification | Certifying partner/external auditor | [Certificate of Recognition](https://www.alberta.ca/get-certificate-recognition) |

The system must never invent one universal roofing wind or temperature limit. Combine current OHS
requirements, manufacturer instructions, equipment limits, site conditions, and competent
supervisor/worker observations.

## WCB and subcontractors

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Hiring contractor/subcontractor | Retrieve clearance before work, monitor during contract, and retrieve again before final payment; classify uncovered/deemed-worker risk | WCB authoritative status and finance hold | [Coverage for contractors and subcontractors](https://www.wcb.ab.ca/insurance-and-premiums/types-of-coverage/coverage-for-contractors-and-subcontractors.html) |
| WCB status changes or payment release | Automatic clearance monitoring, stop assignment/payment when status requires resolution | WCB/finance owner | [When a clearance is needed](https://www.wcb.ab.ca/insurance-and-premiums/clearance-letters/when-is-a-clearance-needed/index.html) |

Do not accept an uploaded clearance letter as indefinitely current. Store the issuer reference,
coverage scope, industry, effective time, and fresh lookup evidence.

## Trades and competency

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Layout, preparation, fabrication, assembly, or installation of regulated sheet-metal items | Map task to restricted activities before assignment | Registered apprentice under compliant supervision, certified journeyperson, or recognized credential | [Sheet Metal Worker scope](https://tradesecrets.alberta.ca/trades-in-alberta/profiles/011/scope-of-profession/) |
| Restricted activity in compulsory trade | Credential status, apprentice registration, mentor assignment, ratio, expiry, and task authorization | Alberta Apprenticeship and Industry Training authority | [Compulsory certification trades](https://tradesecrets.alberta.ca/trades-in-alberta/compulsory-certification-trades/) |

Do not classify every warehouse touch or machine interaction as a restricted activity without
mapping the actual task. Do not classify regulated fabrication/installation as unregulated merely
because a machine performs part of it.

## Employment

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Scheduling employees | Start/end notice, daily limit, breaks, rest between shifts, weekly rest, exception handling | HR/payroll review for applicable industry exceptions | [Hours of work and rest](https://www.alberta.ca/hours-work-rest) |
| Overtime | General 8/44 calculation plus applicable occupation/industry rules and valid arrangements | Payroll/HR | [Overtime hours and pay](https://www.alberta.ca/overtime-hours-overtime-pay) |
| Construction-specific employment rules | Construction holiday/vacation, pay, deduction, record, and termination rules where applicable | HR/legal/payroll | [Employment standards for construction webinars and resources](https://www.alberta.ca/employment-standards-webinars) |

The system must separately determine employee versus genuine independent contractor status. A
contract label alone is not proof.

## Construction payment and lien

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Proper invoice under applicable construction contract | Required fields, receipt timestamp, 28-day owner payment timer, 14-day dispute timer | Contract/legal/accounting applicability | [Prompt payment rules](https://www.alberta.ca/prompt-payment-rules-for-construction-industry) |
| Contractor paid and subcontractor amount owing | Seven-calendar-day downstream payment timer or valid non-payment process | Finance/legal | [Prompt payment rules](https://www.alberta.ca/prompt-payment-rules-for-construction-industry) |
| Unpaid work/material | Preserve last-work/material date, legal land description, owner/contracting party, amount, and ordinary 60-calendar-day warning; do not auto-file | Alberta construction lawyer/authorized filer | [Construction lien](https://landregistry.alberta.ca/customer-service/help/completing-land-titles-forms/construction-lien) |
| Holdback, release, adjudication, public works, oil/gas, ready-mix, or lien enforcement | Apply exact statutory/project rules; do not generalize ordinary lien workflow | Alberta construction lawyer | [Prompt Payment and Construction Lien Act](https://www.canlii.org/en/ab/laws/stat/rsa-2000-c-p-26.4/latest/rsa-2000-c-p-26.4.html) |

### Billing control

The accounting/operations state must preserve:

- contract and proper-invoice applicability;
- invoice delivery proof;
- work/material period;
- disputed/undisputed amount and notice;
- owner, contractor, subcontractor, and supplier payment chain;
- holdback classification;
- last-work/material dates;
- lawyer escalation deadlines.

Agents may calculate and warn. They may not issue legal advice or file a lien without delegated
legal authority.

## Tax and accounting

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| GST/HST small-supplier threshold, voluntary registration, or registered business | Registration status, taxable supply, place/rate, invoice, input tax credit evidence, filing/remittance calendar | Accountant/CRA | [When to register and start charging GST/HST](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html) |
| More than 50% of income-earning activity is construction and qualifying Canadian-resident subcontractor payments exceed the current threshold | Capture recipient identity/program account or SIN securely, payments, goods/service classification, reporting period; prepare T5018 | Accountant/CRA | [T5018 statement of contract payments](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/completing-filing-information-returns/t5018-slip-statement-contract-payments.html) |
| Employee pay | Payroll account, taxable benefit/deduction, remittance, T4, ROE, records | Accountant/payroll authority | [Payroll overview](https://www.canada.ca/en/services/taxes/payroll.html) |
| Alberta corporation | Corporate return, instalment, balance, records, annual return | Accountant/CRA/Alberta | [Alberta corporate income tax](https://www.alberta.ca/corporate-income-tax) |

The current CRA T5018 page states the reporting test includes more than 50% construction income,
Canadian-resident construction subcontractors, and more than $500 in payments excluding GST/HST
for the threshold calculation. Reverify at each reporting period.

## Privacy, recordings, and cybersecurity

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Collect/use/disclose customer, worker, applicant, contractor, photo, voice, GPS, property, or device data | Reasonable purpose, notice/consent where required, minimization, access, correction, protection, retention, destruction, disclosure log | Privacy owner/legal for exceptional use | [Privacy laws in Alberta](https://oipc.ab.ca/resource/privacy-laws-in-alberta/) |
| Loss or unauthorized access/disclosure | Contain, investigate, assess real risk of significant harm, notify Commissioner/individuals without unreasonable delay when required | Privacy owner/legal/OIPC | [PIPA breach notification](https://oipc.ab.ca/breach-notification/) |
| Recording a call | Inform caller of recording and purpose and obtain/record appropriate consent; provide non-recorded alternative when policy requires | Privacy/legal | [Recording customer calls](https://www.priv.gc.ca/en/privacy-topics/surveillance/02_05_d_14/) |
| Device/camera/drone/wearable/GPS | Purpose, scope, access, bystander/worker/customer notice, retention, security, and no hidden productivity surveillance | Privacy and employment review | [Privacy laws in Alberta](https://oipc.ab.ca/resource/privacy-laws-in-alberta/) |

Customer evidence may never be committed to the source repository. Use synthetic fixtures in Git
and approved private evidence stores for real records.

### Customer portal first open of a proposal

Migration `0163_customer_portal_proposal_views.sql` adds one customer data class: the first time
someone holding a customer's portal link opened a published proposal.

| Control | Record |
|---|---|
| Stored | Tenant, portal link, job, customer, proposal pack, revision and publication ids, and one timestamp |
| Not stored | IP address, user agent, location, or any later visit |
| Meaning | Someone holding the customer's link opened the proposal. It does not show that the customer read it: a forwarded link opens it too, and a headless email link scanner that runs the page's script may count as an open |
| Purpose | Evidence that the offer was opened through the customer's link, kept in the business's own record of the terms it offered |
| Staff opens | Not recorded when the app marks the request as a staff preview (`staff_preview`, sent while an office sign-in is live in that browser) or when it comes from the device that issued the link. A staff member on another device or browser without a sign-in counts as the customer. A forged flag can only stop a record, never make one |
| Retention | At most 3 years (owner decision). D1 refuses to delete a row younger than 3 years by its own clock; the daily cron deletes older rows, 500 at a time, before it prunes portal links. The link prune keeps every link a row names, so that link's issuer hashes (`issued_ip_hash`, `issued_user_agent_hash`) live as long as its last first-open row |
| Notice | The portal privacy notice must say that the first open is recorded and kept for at most 3 years. The owner and the privacy owner approve that text before the switch goes on |
| Switch | `APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED` is `"false"` in every checked-in environment. Deletion after 3 years exists, so it can go on once the owner approves the notice text |

## AI model providers

Every model call that can carry customer, worker or job data names one provider account below by
its `Ref`. The agent runtime's `compliance_ref` must equal one of these refs, and the runtime refuses
production and shadow runs for an account whose ref is missing or marked "not permitted". The
providers in scope are the agent gateway's `claude` and `codex` routes (`agent-host/config/gateway.json`)
and the Worker's measurement OCR call to the Anthropic API (`MEASUREMENT_OCR_API_KEY`). Provider terms
change; re-read the sources on the review trigger above and before any account change.

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Personal information goes to a model provider outside Canada (every provider below processes outside Canada; none offers Canadian inference) | Privacy policy names the countries and the purposes; notice before collection or transfer says how to get that policy and who answers questions; pseudonymise before any prompt where the runtime can; send only the fields the task needs | Privacy owner approves the policy and notice text | [PIPA s.6, s.13.1](https://kings-printer.alberta.ca/documents/Acts/P06P5.pdf), [OIPC P2010-IR-02](https://oipc.ab.ca/p2010-ir-02/) |
| A provider account is used for business data | Account is on commercial terms with a data processing addendum, no training on business data, and the shortest retention the provider offers; the runtime records the `Ref` on every run | Owner signs the provider terms and DPA and sets the account's data controls | Per row below |
| A provider processes on the organization's behalf | The organization stays accountable for the provider: security, breach notification path, retention limits | Privacy owner | [PIPA s.5(2), s.34, s.34.1, s.35](https://kings-printer.alberta.ca/documents/Acts/P06P5.pdf) |

| Ref | Account type | Terms and DPA | Training on business data | Retention | Processing region | Production business data |
|---|---|---|---|---|---|---|
| `ai.anthropic.api` | Anthropic API, organization API key | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) with the [DPA](https://www.anthropic.com/legal/data-processing-addendum) incorporated | Not used for training under the commercial terms ([source](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)) | Deleted within 30 days by default; zero data retention by agreement, per organization, with listed feature exceptions; policy-flagged traffic is kept longer ([retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)) | Global by default; US-only inference selectable per request or workspace; no Canadian region ([data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)) | **Permitted** with a workspace pinned to US inference; request zero data retention |
| `ai.anthropic.claude-commercial` | Claude Team or Enterprise seat, Claude Code OAuth token issued from that organization | Commercial Terms and DPA ([Claude Code legal](https://code.claude.com/docs/en/legal-and-compliance)) | Not used by default ([Claude Code data usage](https://code.claude.com/docs/en/data-usage)) | 30 days; zero data retention only for qualified Enterprise organizations ([ZDR](https://code.claude.com/docs/en/zero-data-retention)) | No region control on Team; US-only inference on usage-based Enterprise | **Permitted**; issue the token from the organization, never a personal account; disable telemetry, error reporting and the feedback command |
| `ai.anthropic.claude-consumer` | Claude Pro or Max, Claude Code OAuth token from a personal account | [Consumer Terms](https://www.anthropic.com/legal/consumer-terms); no DPA found | Used when the model-improvement setting is on ([source](https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training)) | Up to 5 years with model improvement on, 30 days with it off; no zero data retention ([source](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data)) | No region control | **Not permitted**: consumer terms, no DPA, and the terms limit automated access to API keys; `eval_history` only under the recorded exception below |
| `ai.openai.api` | OpenAI API, organization API key | [Services Agreement](https://openai.com/policies/services-agreement/) with the [DPA](https://openai.com/policies/data-processing-addendum/) | Not used unless the organization opts in ([your data](https://developers.openai.com/api/docs/guides/your-data)) | Abuse-monitoring logs up to 30 days; zero data retention or modified abuse monitoring by approval | US storage and processing selectable; Canada storage only, no Canadian inference | **Permitted** with a US project; request zero data retention or modified abuse monitoring |
| `ai.openai.chatgpt-commercial` | ChatGPT Business or Enterprise workspace, Codex access token | Services Agreement with DPA ([enterprise privacy](https://openai.com/enterprise-privacy/)) | Not used by default ([source](https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance)) | Admin-set retention, deleted within 30 days; Codex zero data retention not confirmed | Business: no residency; Enterprise: Canadian storage for new customers, no Canadian inference ([residency](https://help.openai.com/en/articles/9903489-data-residency-and-inference-residency-for-chatgpt)) | **Conditional**: permitted after the owner confirms Codex retention in writing; prefer `ai.openai.api` |
| `ai.openai.chatgpt-consumer` | ChatGPT Plus or Pro sign-in (`auth.json` from a personal account) | [Terms of Use](https://openai.com/policies/terms-of-use/); no DPA | Used unless "Improve the model for everyone" is off ([data controls](https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt)) | Kept until deleted, then up to 30 days; no zero data retention | No region control | **Not permitted**: consumer terms, no DPA, and the terms prohibit programmatic extraction; `eval_history` only under the recorded exception below |

Whether pseudonymised prompts still carry personal information for a provider, and whether
consent beyond the s.13.1 notice is needed, are questions for privacy counsel; the controls above
apply until counsel decides otherwise.

### Recorded exceptions

An exception narrows one "not permitted" verdict to one named run class under an explicit owner
risk acceptance. It never extends to live or shadow runs, which stay refused on every consumer ref.

| Refs | Run class allowed | Accepted by | Reason | Conditions | Ends on |
|---|---|---|---|---|---|
| `ai.anthropic.claude-consumer`, `ai.openai.chatgpt-consumer` | `eval_history` only: offline evaluation on real, pseudonymised history | Owner, explicit risk acceptance | Agent quality has to be measured on real history before production, and the business accounts (`ai.anthropic.claude-commercial`, `ai.openai.chatgpt-commercial`) are not yet issued; the owner accepts consumer terms without a DPA for this run class only | Pseudonymise before any prompt; history stays in git-ignored `output/` and local D1 on the operator machine; logs carry counts only; Claude's model-improvement setting and ChatGPT's "Improve the model for everyone" are off on the accounts used; every run records the consumer `Ref` and the run class | The provider's business account is issued; `eval_history` then moves to the commercial ref and this row is removed |

## Electronic and telephone marketing

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Commercial email/SMS or similar electronic message | Prove express/implied consent or exception; sender/contact identity; working unsubscribe; process withdrawal within current deadline | Compliance owner for campaign policy | [CRTC CASL FAQ](https://www.crtc.gc.ca/eng/com500/faq500.htm) |
| Implied consent | Record relationship/inquiry event, permitted purpose, start/expiry, and suppression; do not convert inquiry into perpetual consent | Compliance policy | [CRTC implied-consent guidance](https://crtc.gc.ca/eng/com500/guide.htm) |
| Telemarketing by company or agent | Register as required even for some exempt activity; subscribe/scrub for non-exempt calls; identify caller; maintain internal DNC | DNCL account/compliance owner | [Who must register](https://www.lnnte-dncl.gc.ca/en/Organization/WhoShouldRegister) |
| Consumer requests no calls | Add to internal DNC and suppress within current regulatory deadline; apply across vendors | Compliance owner | [National DNCL exemptions and internal list](https://www.lnnte-dncl.gc.ca/en/Organization/Exemptions) |

The current CRTC guidance states CEMs generally require consent, identification, and unsubscribe;
unsubscribe requests must be honoured within ten business days. Current DNCL guidance requires an
internal do-not-call list even for exempt calls.

## Advertising and sales claims

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Performance, lifespan, maintenance, energy, durability, insurance, or comparative claim | Adequate/proper test or authoritative scoped evidence before publication; preserve general impression | Claims owner/legal for high-risk claim | [Performance claims](https://competition-bureau.canada.ca/en/deceptive-marketing-practices/types-deceptive-marketing-practices/performance-claims-not-based-adequate-and-proper-test) |
| Environmental/recyclability/carbon/efficiency claim | Truthful specific wording, scope, substantiation, material qualification, and general-impression review | Claims owner/legal | [Environmental claims and greenwashing](https://competition-bureau.canada.ca/en/how-we-foster-competition/education-and-outreach/environmental-claims-and-greenwashing) |
| Sale/reference/ordinary price | Preserve actual selling/offer history and legal basis; no invented anchor or countdown | Marketing/legal | [Ordinary selling price](https://competition-bureau.canada.ca/en/deceptive-marketing-practices/types-deceptive-marketing-practices/ordinary-selling-price) |

## Asbestos, waste, and environment

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Building/material may contain asbestos and planned work may disturb it | Stop, assess/sample through competent process, define abatement authority, notify OHS at least 72 hours before qualifying work, preserve disposal evidence | Qualified asbestos professional/OHS | [Submit an asbestos project notification](https://www.alberta.ca/submit-asbestos-project-notification) |
| Construction/demolition waste | Classify metal, shingles, wood, packaging, chemical/hazardous, battery/e-waste, asbestos; use approved destination; retain weight/ticket | Facility/waste authority | [Edmonton waste disposal rates and requirements](https://www.edmonton.ca/programs_services/garbage_waste/disposal-rates) |

Scrap revenue, customer salvage, hazardous products, and disposal cost must reconcile to the job
and inventory. Waste diversion claims require evidence.

## Fleet and cargo

| Trigger | Required system control | Human/external gate | Primary source |
|---|---|---|---|
| Truck/trailer combination at or above 11,794 kg operating only in Alberta, or over 4,500 kg transporting goods outside Alberta | Safety Fitness Certificate determination, pre-entry, designated officer, certificate, program, review | Alberta Transportation | [Pre-entry requirements](https://www.alberta.ca/pre-entry-requirements-commercial-carriers) |
| Commercial vehicle over applicable inspection threshold | Inspection schedule/certificate and out-of-service block | Licensed inspection facility | [Commercial vehicle inspection program](https://www.alberta.ca/vehicle-inspection-program-commercial-vehicles) |
| Truck over 4,500 kg carrying cargo | NSC-10 securement policy, equipment, inspection, driver evidence | Competent driver/carrier | [Vehicle standards](https://www.alberta.ca/vehicle-standards) |
| Vehicle at/above 11,794 kg where trip inspection applies | Trip inspection schedule/report and defect disposition | Driver/carrier | [Vehicle standards](https://www.alberta.ca/vehicle-standards) |

The system must calculate obligations from registered/licensed weight, combination, use, and
territory rather than vehicle appearance.

## Insurance and warranty

Government consumer guidance recommends verifying liability/property-damage insurance and WCB.
The exact insurance program is broker-specific. The system must maintain:

- CGL/completed operations;
- property/business interruption;
- tools/equipment/installation floater;
- commercial auto/trailer;
- cyber/privacy/crime;
- equipment breakdown;
- professional/design, pollution/asbestos, builder's risk, bonds, and umbrella when the actual
  scope requires them;
- policy, limit, deductible, exclusion, territory, operations, endorsement, certificate, claim,
  notice deadline, and renewal.

Product and workmanship warranties must identify issuer, exact system/material/lot, coverage,
exclusion, maintenance, transfer, claim method, effective/expiry, and evidence. Marketing language
cannot broaden the executed warranty.

## Human signoffs that remain in the target

Reliable agents do not replace:

- customer contract/selection/cancellation/change acceptance;
- worker site acknowledgement and stop-work;
- competent physical inspection and release until validated machinery lawfully owns it;
- certified trade/supervisor work where required;
- engineer, permit authority, inspector, WCB, CRA, insurer, lender, manufacturer, or regulator
  decisions;
- owner/director capital, ethics, risk, policy activation, and exceptional dispute decisions;
- lawyer/accountant/broker/safety review where professional judgment is required.

## Review evidence

Review is event-triggered, never calendar-gated. A review runs on each event in the `Review events`
header and on every `Immediate review trigger`:

- `provider-terms-change`: an AI-provider, processor, or vendor changes its terms, data-use,
  retention, or region commitments;
- `provider-added`: a new provider, processor, or account type is proposed for business data;
- `production-release`: before each production release is promoted.

The `Last review` header names the trigger of the most recent completed review. Each review must
produce a compliance-review event containing:

- source URLs and retrieval time;
- changed/unchanged determination;
- affected policies, contracts, agents, tools, forms, work packages, and jobs;
- reviewer and qualification;
- effective date;
- rollout/communication/training actions;
- superseded policy versions;
- tests and blocked production transitions until rollout completes.
