-- 0169_inventory_invoice_readback_action.sql - an AP invoice line cites a QuickBooks bill read,
-- never just any finished effect.
--
-- 0067's inventory_invoice_lines_readback_guard admitted an AP invoice line on any succeeded or
-- reconciled effect of the tenant whose readback hash matched, whatever that effect did: a Frappe
-- write, a proposal send or an email would do. It is re-created here under the same name. 0067's
-- body is kept line for line, and three things are added:
--   - a supplier_ap line is refused with its own code: no read action exists for that provider
--     yet, so nothing can prove one;
--   - the cited effect's action must be 'quickbooks.bill.read';
--   - the cited effect's provider must be the line's own provider.
-- Nothing in this guard reads a time, so no clock is involved.
--
-- No Worker code writes inventory_invoice_lines today, so no live path changes. The line is
-- append-only (0067), and the cited effect's tenant, action and provider are frozen by 0042's
-- external_effect_binding_guard, so a line cannot be re-pointed after it is written.
--
-- The effect-runtime token's action allowlist (`mcp.*`, plus the QA seed's stand-in publish on a
-- synthetic Worker) ships with this file but lives only in the Worker: D1 cannot tell a token
-- write from a bus write, because neither external_effect_attempts nor external_effect_events
-- records a claimer.
--
-- No migration from 0200 up touches inventory_invoice_lines or external_effects.

DROP TRIGGER IF EXISTS inventory_invoice_lines_readback_guard;

-- An AP invoice line is admissible only from a succeeded, authenticated provider readback.
-- A webhook notification is never sufficient.
CREATE TRIGGER inventory_invoice_lines_readback_guard
BEFORE INSERT ON inventory_invoice_lines
BEGIN
  SELECT RAISE(ABORT, 'inventory_invoice_line_supplier_ap_readback_unsupported')
  WHERE NEW.provider = 'supplier_ap';

  SELECT RAISE(ABORT, 'inventory_invoice_line_authenticated_readback_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM external_effects AS effect
    WHERE effect.effect_id = NEW.readback_effect_id
      AND effect.tenant_id = NEW.tenant_id
      AND effect.state IN ('succeeded', 'reconciled')
      AND effect.readback_hash = NEW.readback_hash_sha256
      AND effect.action = 'quickbooks.bill.read'
      AND effect.provider = NEW.provider
  );

  SELECT RAISE(ABORT, 'inventory_invoice_line_po_identity_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM inventory_po_lines AS ordered
    WHERE ordered.po_line_id = NEW.po_line_id
      AND ordered.tenant_id = NEW.tenant_id
      AND ordered.item_id = NEW.item_id
  );
END;
