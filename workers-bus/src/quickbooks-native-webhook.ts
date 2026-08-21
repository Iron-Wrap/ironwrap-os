// quickbooks-native-webhook.ts - signed webhook triggers for the native accounting ledger.
//
// A webhook contains identity only. This adapter turns that identity into an authenticated
// provider-detail read and lets the accounting reconciliation engine judge it. It never treats the
// signed body as money truth and never invents an accounting intent for an unknown provider row.

import type { AppEnv } from "./app-types.ts";
import { ingestObservedPayment } from "./accounting-payments.ts";
import {
  reobserveAccountingIntent,
  resolveAccountingObservationBinding,
  type AccountingObservationBinding,
} from "./accounting-reobservation.ts";
import type { QbEntityEvent } from "./quickbooks.ts";

export interface QuickBooksWebhookProjectionResult {
  intentIds: string[];
  unresolved: boolean;
  verdicts: string[];
}

export interface QuickBooksWebhookProjectionPort {
  assertReady(realmId: string): Promise<void>;
  project(event: QbEntityEvent): Promise<QuickBooksWebhookProjectionResult>;
}

export class QuickBooksNativeWebhookError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "QuickBooksNativeWebhookError";
  }
}

/** Production port; the optional port at `handleQuickbooksWebhook` is a deterministic test seam. */
export function nativeQuickBooksWebhookProjectionPort(
  env: AppEnv,
  fetcher: typeof fetch = fetch,
): QuickBooksWebhookProjectionPort {
  let ready: Promise<{
    tenantId: string;
    binding: AccountingObservationBinding;
    realmId: string;
  }> | null = null;

  const resolve = async (realmId: string) => {
    if (!ready) {
      ready = (async () => {
        const tenantId = String(env.APP_TENANT_ID ?? "").trim();
        if (!tenantId)
          throw new QuickBooksNativeWebhookError(
            "quickbooks_native_tenant_not_configured",
          );
        const binding = await resolveAccountingObservationBinding(env, {
          tenantId,
          fetcher,
        });
        if (!binding)
          throw new QuickBooksNativeWebhookError(
            "quickbooks_native_observation_not_ready",
          );
        const active = await binding.auth
          .activeRealm(tenantId)
          .catch(() => null);
        if (!active)
          throw new QuickBooksNativeWebhookError(
            "quickbooks_native_observation_not_ready",
          );
        return { tenantId, binding, realmId: active.realmId };
      })();
    }
    const value = await ready;
    if (value.realmId !== realmId) {
      throw new QuickBooksNativeWebhookError(
        "quickbooks_native_realm_mismatch",
      );
    }
    return value;
  };

  return {
    async assertReady(realmId) {
      await resolve(realmId);
    },

    async project(event) {
      const { tenantId, binding } = await resolve(event.realmId);
      const now = new Date();
      if (event.type === "Payment") {
        const observed = await ingestObservedPayment(
          env,
          binding.auth,
          {
            tenantId,
            paymentEntityId: event.id,
            source: "webhook_triggered_read",
          },
          binding.fetcher ?? fetcher,
          now,
        );
        if (observed.status !== "observed") {
          throw new QuickBooksNativeWebhookError(
            observed.status === "not_found"
              ? "quickbooks_native_provider_identity_unbound"
              : observed.detailCode ??
                "quickbooks_native_provider_read_unavailable",
          );
        }
        const incomplete = observed.settlements.find(
          (settlement) => settlement.status === "skipped",
        );
        if (incomplete) {
          throw new QuickBooksNativeWebhookError(
            incomplete.reason ?? "quickbooks_native_payment_reconciliation_pending",
          );
        }
        if (observed.settlements.length === 0) {
          throw new QuickBooksNativeWebhookError(
            "quickbooks_native_provider_identity_unbound",
          );
        }
        return {
          intentIds: observed.settlements.map(
            (settlement) => settlement.intentId,
          ),
          unresolved: false,
          verdicts: observed.settlements.map(
            (settlement) =>
              settlement.reconciliation?.verdict ??
              settlement.reason ??
              settlement.status,
          ),
        };
      }

      const matches = await env.DB.prepare(
        `SELECT intent_id FROM accounting_intents
          WHERE tenant_id = ? AND realm_id = ?
            AND provider_entity_type = ? AND provider_entity_id = ?
          ORDER BY created_at, intent_id LIMIT 2`,
      )
        .bind(tenantId, event.realmId, event.type, event.id)
        .all<{ intent_id: string }>();
      const rows = matches.results ?? [];
      if (rows.length === 0) {
        throw new QuickBooksNativeWebhookError(
          "quickbooks_native_provider_identity_unbound",
        );
      }
      if (rows.length > 1) {
        throw new QuickBooksNativeWebhookError(
          "quickbooks_native_provider_identity_conflict",
        );
      }
      const observed = await reobserveAccountingIntent(
        env,
        binding,
        {
          tenantId,
          intentId: rows[0]!.intent_id,
          source: "webhook_triggered_read",
        },
        now,
      );
      if (observed.status === "unavailable") {
        throw new QuickBooksNativeWebhookError(
          observed.detail_code ?? "quickbooks_native_provider_read_unavailable",
        );
      }
      return {
        intentIds: [observed.intent_id],
        unresolved: false,
        verdicts: [observed.verdict ?? observed.state],
      };
    },
  };
}
