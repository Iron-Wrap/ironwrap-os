-- 0132_cron_heartbeat.sql
--
-- IRO-262. One current row per declared cron schedule: when its last tick started, when the
-- composed work it owns last settled, and what that settlement was. Seeded by this migration so
-- "never ticked" has a bounded origin (`seeded_at`) for the post-deploy grace period, rather than
-- reading as indistinguishable from "the schema is missing".

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  cron        TEXT PRIMARY KEY,   -- the schedule exactly as wrangler.jsonc and Cloudflare spell it
  started_at  TEXT,               -- ISO 8601 of the last tick that STARTED; NULL until the first one
  finished_at TEXT,               -- ISO 8601 of the last tick whose composed work settled
  status      TEXT NOT NULL,      -- seeded|running|ok|error
  seeded_at   TEXT NOT NULL       -- row birth; the origin of the post-deploy grace window
);

INSERT INTO cron_heartbeat (cron, started_at, finished_at, status, seeded_at)
VALUES ('*/5 * * * *', NULL, NULL, 'seeded', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
ON CONFLICT(cron) DO NOTHING;

INSERT INTO cron_heartbeat (cron, started_at, finished_at, status, seeded_at)
VALUES ('0 14 * * *', NULL, NULL, 'seeded', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
ON CONFLICT(cron) DO NOTHING;
