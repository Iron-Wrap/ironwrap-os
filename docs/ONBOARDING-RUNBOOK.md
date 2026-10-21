# Onboarding Runbook — setting up a new company

How a company goes from an empty IronWrap OS tenant to working in it: company details, logo,
people, and its first lead. **Everything in Part 2 is done from the app, on a phone or a laptop,
by whoever runs the company.** No JSON file, no `curl`, no ERPNext administration interface.

There is exactly one step an engineer still owns (Part 1), and one that is a documented one-shot
API call because there is no account yet to sign in with (step 1.4). Both are named plainly below;
if any other step needs an engineer, that is a defect — report it rather than working around it.

Related: `docs/WHITE-LABEL-CLONE-PLAYBOOK.md` is the authority for what a tenant *is* and how the
infrastructure is provisioned. This runbook is what happens afterwards.

---

## Part 1 — one engineer setup, once per company

Someone with repo and Cloudflare access does this once. About 30 minutes on a stack that already
exists; longer if the Cloudflare resources are new.

1. **Create the tenant configuration and Worker namespace.** Follow
   `docs/WHITE-LABEL-CLONE-PLAYBOOK.md` "The Automated Path". You will need the company's
   short id (`<tenant>`, lowercase, e.g. `freshco`), its display name, and one sender mailbox on a
   domain it owns.
2. **Deploy the Worker and apply the migration chain.** Playbook step 2.
3. **Point the company's own web address at the Worker** and add it to
   `APP_ALLOWED_ORIGINS` / `APP_PUBLIC_ORIGIN`. Until this is done nobody can sign in.
4. **Create the very first owner account.** This is the one call that cannot come from inside the
   app — there is no session yet to authorize it. It is a strict one-shot: the second call answers
   `409 first_owner_bootstrap_completed`.

   ```bash
   curl -X POST https://<company-address>/admin/app-users/bootstrap \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"tenant_id":"<tenant>","email":"owner@example.com","display_name":"Owner Name"}'
   ```

   Hand the owner their email address and the sign-in page address. Nothing else.
5. **If the company wants the public request form**, set `PUBLIC_ESTIMATE_ENABLED=true` and its
   Turnstile keys on the Worker. The *brand name* shown on that form is not set here — the owner
   sets it in step 2.2 below.

**What Part 1 does NOT decide:** the company's name, logo, address, who works there, or what the
customer-facing form is called. All of that is the owner's, from the app.

---

## Part 2 — the owner sets up their own company

Time: about 10 minutes. Works on a phone.

### 2.1 Sign in

1. Open the company's address and go to **`/settings`**.
2. Enter the email address from step 1.4 and ask for a sign-in link.
3. Open the link from the email. There is no password anywhere in this product; links last 15
   minutes and are single use.

> Land on `/settings`, not on `/`. `/` is the crew's Field Companion entry point and asks an
> unpaired phone to pair a device rather than showing the sign-in form.

### 2.2 Company details — **Settings → Company details**

Fill in and save:

- **Company name** — the full name on your contracts and invoices.
- **Short name** — what customers see on your request form and in the app header.
- **What you do and where** — one line, shown under your name on the customer request form.
- Phone, email, website, and your main office address.

Then **upload your logo** — PNG, JPG, WEBP or SVG, up to 512 KB. It appears immediately in the app
header for everyone and on your public request form. Replace or remove it at any time from the same
screen.

The company name and short name start out as whatever the engineer set in step 1.1. Changing them
here is what the customer sees from then on; nobody has to touch a configuration file.

### 2.3 People — **Settings → People**

For each person who works here, enter their name and work email and choose what they can see:

| Role | Sees |
| --- | --- |
| Owner | Everything, including money and company setup |
| Operations | Every desk; changes no money |
| Sales | Leads and quotes |
| Production | The job runway and crew scheduling |
| Accounting | The money desk and QuickBooks |
| Crew | The crew phone app on a paired phone |

They can sign in as soon as you add them, from the same page you did, with their own email address.
No password is created or shared.

To take access away, use **Remove access** — the person stays on the list (so you can give it back
later) but every session, sign-in link and paired device of theirs stops working immediately. You
cannot remove your own access; that is deliberate.

**Create at least one Crew account before step 2.4** — a phone can only be paired to an existing
crew account.

### 2.4 Crew phones — **Settings → Crew phones**

Pick the crew member, show them the QR code, and have them scan it on the phone they will use on
site. That phone then works offline: it keeps its assigned jobs, check-ins and photos on the device
and sends them when signal returns.

### 2.5 Your first customer — **Sales → Add a lead**

Enter the person's name and either a phone number or an email address. Everything else — the
address, what they need, and any notes — is optional and can be typed exactly the way the customer
said it, including a service you have never sold before.

The lead lands on the sales desk immediately, the same way a website request or a phone call does.
If you enter the same person twice, the desk says so and does not create a second record.

### 2.6 The public request form (only if Part 1 step 5 was done)

Send customers to `https://<company-address>/estimate`. It shows your company name, your service
line and your logo, taken from step 2.2 — no engineer edits it.

If your Worker accepts more than one brand (a second trading name, for example), each one can be
named from the company profile; the list of brands the server accepts is set by the deployment, and
what each one is *called* is yours.

---

## Checklist

A company is onboarded when all of these are true:

- [ ] The owner can sign in without help.
- [ ] Company details are saved and the logo shows in the app header.
- [ ] Every person who works here has an account with the right role.
- [ ] At least one crew phone is paired.
- [ ] At least one real lead is on the sales desk.
- [ ] Nobody has been asked to open the ERPNext administration interface, run a command, or edit a
      file.

---

## If something is missing

Anything in Part 2 that cannot be done from the app is a defect. Record it against the milestone
issue with the screen you were on and what you expected — do not work around it with a `curl` call,
because the next company will hit exactly the same wall.

Known limits in this version:

- **Pipelines, job cards and forms are not configurable yet.** Configurable pipelines are M3 and
  form customisation is M5.
- **Existing CRM data is not imported here.** Bringing in an existing customer list is a separate
  import path.
- **Brand names for a multi-brand deployment** can be edited, but adding or removing a brand id the
  server accepts still needs a deployment change.
