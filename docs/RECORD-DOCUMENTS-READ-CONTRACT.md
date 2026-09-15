# Record documents read contract

Status: source-level route contract
Owner: IronWrap OS product owner
Last verified: 2026-08-28
Review trigger: any change to `workers-bus/src/schema-forms-api.ts` document routes,
`recordReadableByActor` in `workers-bus/src/schema-forms.ts`,
`workers-bus/src/document-templates.ts`, or `app/src/documents/`

## Truth boundary

This page is the request/response contract for `GET /api/v1/documents/{entity_type}/{entity_id}`,
the read that publishes an administrator's document LAYOUT to the people who do the work. Both
halves are in source: the PWA reader is `app/src/documents/` and the handler is `recordDocuments`
in `workers-bus/src/schema-forms-api.ts`, gated by `recordReadableByActor`
(`workers-bus/src/schema-forms.ts`) — the same record-level gate
`listAuthorizedSchemaFieldValues` applies, extracted so a second record read cannot drift from it.

The two halves are proven to agree rather than assumed to:
`workers-bus/test/record-documents-api.test.ts` imports the client's own
`entityDocumentsResponseSchema` from `app/src/documents/document-contracts.ts` and parses real
handler responses with it, so a renamed or dropped key fails the Worker suite instead of rendering
an empty shelf on a phone. That import needs the PWA's dependencies installed
(`npm ci --prefix app`), which is the order CI already installs them in.

Templates, revisions and generation receipts live in `workers-bus/src/document-templates.ts` and
`workers-bus/migrations/0125_document_templates_and_generation.sql`. Per-field read authority lives
in `listAuthorizedSchemaFieldValues` (`workers-bus/src/schema-forms.ts`).

A route in source is only **Implemented**. Use [`CAPABILITY-MATRIX.md`](CAPABILITY-MATRIX.md) for
current implementation gaps and
[`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](AUTHORITY-AND-EVIDENCE-CONTRACT.md) for the proof boundary.

## What the surface is for

A contract, an estimate and a materials list must be smart forms filled from the job and reachable
in the workflow, not static files in a separate area. `/api/v1/admin/document-templates` is where an
owner authors them and is owner-only, correctly: authoring is configuration. Reading is not. The
shop and the crew never see the templates route, so today a generated document exists in R2 with no
screen that opens it.

## Shape

```
GET /api/v1/documents/{entity_type}/{entity_id}
200 {
  "entity_type": "job",
  "entity_id": "roof-job-1",
  "documents": [
    {
      "template_id": "tpl_...",
      "template_key": "materials_list",
      "label": "Materials list",
      "revision_id": "rev_...",
      "version": 3,
      "blocks": [
        { "kind": "heading", "level": 1, "text": "Order for the shop" },
        { "kind": "field", "field_id": "fld_..." },
        { "kind": "text", "text": "Confirm counts with the shop." }
      ]
    }
  ]
}
```

`blocks` is `DocumentTemplateBlock[]` verbatim — the same array
`renderDocumentTemplate` consumes, in authored order.

## Rules the handler must hold

1. **Layout only, never values.** No block carries a value. The reader joins values from
   `GET /api/v1/schema-fields/{entity_type}/{entity_id}`, which is the one read that applies
   per-field authority. Publishing values here would create a second, weaker path to the same data.
2. **Active current revisions of that entity type**, for the tenant on the session. A retired
   template is absent.
3. **Readable by any role the record itself is readable by** — the same gate
   `listAuthorizedSchemaFieldValues` already applies (`roleCanReadField(entity_type, role)` plus a
   tenant-scoped `entityExists`). No new role vocabulary.
4. **404** for an unknown entity type, a record outside the tenant, or a role that may not read the
   record at all. `200` with `"documents": []` for a record that exists and carries none — the PWA
   distinguishes the two and shows nothing either way, but the distinction matters to any other
   consumer.
5. **No authority decision that the record read does not already make.** A reader authorized for
   the record but not for a bound field still receives the block; the field is simply absent from
   their record read, and the PWA marks that line withheld rather than guessing.
6. Read-only. `POST` stays on `/api/v1/document-generations`, owner-only, unchanged. The stored
   file behind a receipt is read only through `GET /api/v1/document-generations/{receipt_id}/document`
   (owner-only, tenant-scoped by the receipt, bytes digest-checked against `output_digest` before
   they leave; `409 document_generation_pending` / `document_generation_not_stored` when the effect
   never reached `succeeded`, `409 document_generation_readback_mismatch` when the object no longer
   matches, `404 document_object_missing` when it is gone). No client composes a storage URL.

### Known boundary: assignment is a per-field decision, not a per-record one

Rule 3 is the whole gate, deliberately: entity type registered, `roleCanReadField(entity_type,
role)`, and a tenant-scoped `entityExists`. Assignment is not part of it. A `field` user reads
`job` values only for the jobs they are assigned — `assignmentAllowed` enforces that per field on
the record read — so an unassigned crew member who calls this route receives the tenant's job
LAYOUT and, from their record read, no values to put in it. Importing the assignment check here
would be an authority decision the record read makes per field, which rule 5 forbids, and would
make a document's presence leak the assignment roster. If the product wants an unassigned crew
member to see nothing at all on a job, that is a change to the job surface's own gate, not to this
route.

## What consumes it

`app/src/documents/document-api.ts` (offline-cached per tenant+user, mirroring the schema-card
client), resolved by `app/src/documents/document-resolution.ts` and rendered by
`app/src/documents/document-section.tsx` on the job workflow surface.

A route in source is only **Implemented**: this page describes tested behaviour against a real
migrated database, not deployment, runtime verification, or business acceptance.
