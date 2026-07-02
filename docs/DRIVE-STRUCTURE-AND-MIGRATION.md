# Google Drive - Target Structure, Roles & OneDrive Migration

Owner supplied (2026-07-02): the role model per pipeline + screenshots of the current OneDrive.
This doc is the target Drive design honoring that role model, and the one-time migration plan.

## What the current OneDrive audit shows (from the owner's screenshots)

- Top level: a loose **"Documents"** share (job files not inside job folders) + **"Residentail
  Jobs"** [sic] (per-job folders + a `_Done` archive, ~741 MB).
- **Two naming conventions in parallel**: `<CODE>26-NNN <Name>` (e.g. `ABN26-002 ...`,
  `ER26-004 ...`) AND reversed `26-171-ABN <Name>`; plus stray typos (`ER260-002` inside an
  `ER26-002` folder, "Residentail", "Wall Rerprot").
- **These codes are manual (GHL-era), NOT JobNimbus job numbers** (JN uses plain 1002, 1003, ...).
  The new automation keys folders by JN number, so a mapping is required.
- **Inconsistent per-job templates**: some jobs = `Before`/`After` + loose files; the newest job
  has `Before / Documents / Info / Notes / Photos` where Info/Notes/Photos are empty (0 KB).
- **Duplicates exist** (same drawings uploaded twice on different dates with near-identical names).
- Supplier/measurement reports carry an external order id prefix (e.g. `1036302 ... Roof/Wall/
  Gutter/Fascia Report`) - consistent with AppliCad/report-service outputs.
- **Scale is small**: single-digit GB, ~6-8 active jobs. Migration is a *mapping* exercise, not a
  data problem.

## The one Google constraint that shapes the design

In a **Shared Drive** you can GRANT extra access to a specific folder (even to non-members), but
you can **NOT hide a folder from a drive member**. So audience separation happens at the DRIVE
level, not the folder level.

## Target: three Shared Drives

| Shared Drive | Members | Contents |
|---|---|---|
| **IW Jobs** | superadmin (Manager) · office/admin · sales · prod manager | All job folders (template below), BOTH brands - everything EXCEPT payment/PII docs |
| **IW Restricted** | superadmin only | Payment records, banking/card details, insurance-claim docs, any sensitive personal docs (the "PII" cut the owner excluded from sales) |
| **IW Archive** | superadmin · office | `_Done` + closed jobs migrated verbatim (no re-sorting effort on closed work) |

Role mapping to the owner's model:
- **superadmin** = Manager on all three drives.
- **sales ("all but PII")** = member of IW Jobs only. Sees contracts/estimates (they sell them);
  never sees IW Restricted. ❓ confirm exactly which docs count as PII for sales (payment/banking/
  insurance is the assumption here).
- **installer ("all but contract, finance, PII")** = **NO drive membership at all.** Installers
  get the work order + job info through the JobNimbus mobile app, and submit photos/forms through
  Jotform (the bus files them into the job folder automatically). If a sub genuinely needs files,
  share that job's `01 Info` or `03 Photos` folder to their Google account per job (folder-level
  grants to non-members are supported). Zero standing access = simplest and safest.
- **customer** = **JobNimbus client portal** (❓ verify it exists on the current JN plan) or, as
  fallback, per-file shares of exactly: proposal, signed contract copy, completion form +
  warranty. Never `04 Materials & Suppliers`, never internal notes.
- **prod manager (Production pipeline)** = member of IW Jobs (works mainly in `02` and `04`).
  In JobNimbus, Production is a second board/workflow; mirror the same role model with JN Access
  Profiles (superadmin / office / sales / limited sub / prod manager).

## Per-job folder template (the bus creates this at job mint)

```
<JN#> <Customer> (<Brand>)/          e.g. "1008 John Smith (IW)"
  01 Info & Notes                    - address, scope, comms notes
  02 Measurements & Reports          - RoofRuler XML/PDF, AppliCad, supplier reports
  03 Photos/  Before / Progress / After
  04 Materials & Suppliers           - materials list, PO copies, supplier docs
  05 Contract & Estimates            - proposal PDF, signed contract
  06 Completion & Warranty           - completion forms, warranty package
```

Naming rule: **JobNimbus number FIRST** (it is the automation key), then customer, then brand
short-code. Legacy codes (`ABN26-002`, `ER26-004`, `26-171-ABN`) live in the migration mapping
sheet, not in folder names. Payment docs (deposits, balances, card/banking anything) go to
**IW Restricted/<JN#> <Customer>/**, not into the job folder.

## Migration plan (one-time, scripted)

1. **Freeze**: from cutover day, new job folders are created ONLY in Drive (by the bus);
   OneDrive goes read-only.
2. **Inventory**: script lists every OneDrive folder/file into a CSV (Make's OneDrive modules or
   rclone with the Microsoft creds).
3. **Mapping sheet** (office, ~1 hour): legacy code -> customer -> JobNimbus job # (create JN
   jobs for active work that lacks a number). Anything closed or in `_Done` -> IW Archive
   verbatim, zero re-sorting.
4. **Copy (scripted)** for ACTIVE jobs into the template: `Before` -> `03 Photos/Before`,
   measurement/supplier reports -> `02`, contracts/estimates -> `05`, materials lists + POs ->
   `04`, balance/payment docs -> **IW Restricted**. While copying: skip empty folders, drop exact
   duplicates, fix name typos.
5. **Verify**: size/count report old-vs-new; office spot-checks 2 jobs end to end.
6. **Retire**: OneDrive stays read-only for 30 days as a safety net -> cancel Microsoft 365.

Prerequisites: the new Google Workspace + Shared Drives exist (owner action), Microsoft creds
available for the copy window.

## Open questions (3)

1. **PII scope for sales**: exactly which docs are cut - payment/banking/insurance only, or more?
2. **Legacy code meanings** (`ABN`, `ER`) for the mapping sheet - brand? area? division?
3. **JobNimbus client portal**: available on the current plan? (decides the customer access path)
