-- 0209_tenant_registry.sql — the tenant registry of a shared multi-tenant Worker.
--
-- Until now one Worker served one tenant: `APP_TENANT_ID` and every tenant-scoped var were
-- pinned at build time, and a second contractor meant a second Worker, D1, R2 and queue set
-- (docs/WHITE-LABEL-CLONE-PLAYBOOK.md). The registry lets one Worker resolve the tenant per
-- request instead (tenancy.ts): the request host names a tenant row, and that row's settings
-- and secrets are laid over `env` before any handler runs, so the ~70 `env.APP_TENANT_ID`
-- readers below the entry point stay as they are.
--
-- The Worker's own vars remain the default tenant. With `APP_MULTI_TENANT_ENABLED` off, or on
-- with no rows here, behaviour is exactly today's. Rows only ever ADD tenants and hosts.
--
-- `settings_json` holds the tenant-scoped var names only (tenancy.ts TENANT_SETTING_KEYS, the
-- same list tools/generate-tenant-worker-config.mjs derives for a clone). `secrets_ciphertext`
-- is an AES-GCM envelope under the Worker secret TENANT_SECRETS_KEK, bound to the tenant id and
-- key version as additional data, so a blob cannot be moved onto another row. Secret values are
-- never written to D1 in the clear and never read back through the admin surface.
--
-- Two tables, no named index and no trigger: the D1 backup/restore inventory moves from 287 to
-- 289 tables; indexes and triggers stay at 396 (383 named idx_%) and 816.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  -- What data this tenant holds, read the way AGENT_DATA_CLASS is: business or synthetic.
  data_class TEXT NOT NULL CHECK (data_class IN ('business', 'synthetic')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(settings_json) AND json_type(settings_json) = 'object'
  ),
  secrets_ciphertext TEXT CHECK (
    secrets_ciphertext IS NULL OR length(secrets_ciphertext) BETWEEN 32 AND 65536
  ),
  secrets_key_version INTEGER CHECK (
    (secrets_ciphertext IS NULL) = (secrets_key_version IS NULL)
    AND (secrets_key_version IS NULL OR secrets_key_version BETWEEN 1 AND 1000000)
  ),
  -- Monotonic per tenant. An admin writer states the version it read; a mismatch is a
  -- conflict, never a silent overwrite of another operator's edit.
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_hosts (
  -- A lowercase hostname without port, exactly as `new URL(request.url).hostname` gives it.
  host TEXT PRIMARY KEY CHECK (
    length(host) BETWEEN 1 AND 253
    AND host = lower(host)
    AND host NOT GLOB '*[^a-z0-9.-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  created_at TEXT NOT NULL
);
