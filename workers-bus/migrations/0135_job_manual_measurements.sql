-- Human observations are a separate ledger. They confer no geometry, takeoff or quote authority.
CREATE TABLE job_manual_observations (
  observation_id TEXT PRIMARY KEY CHECK (length(observation_id)=69 AND observation_id GLOB 'mobs_*' AND substr(observation_id,6) NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  area_id TEXT NOT NULL CHECK (length(area_id)=70 AND area_id GLOB 'marea_*' AND substr(area_id,7) NOT GLOB '*[^0-9a-f]*'),
  area_label TEXT NOT NULL CHECK (length(trim(area_label)) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1000000),
  area_sq_ft REAL CHECK (area_sq_ft IS NULL OR area_sq_ft > 0 AND area_sq_ft <= 250000),
  area_basis TEXT NOT NULL CHECK (area_basis IN ('roof_surface','horizontal_plan','unknown')),
  pitch_rise_per_12 REAL CHECK (pitch_rise_per_12 IS NULL OR pitch_rise_per_12 BETWEEN 0 AND 24),
  method TEXT NOT NULL CHECK (method IN ('tape','laser','plans','drone')),
  uncertainty TEXT CHECK (uncertainty IS NULL OR length(trim(uncertainty)) BETWEEN 1 AND 500),
  correction_reason TEXT CHECK (correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 3 AND 500),
  supersedes_observation_id TEXT,
  previous_head_id TEXT,
  job_version INTEGER NOT NULL CHECK (job_version BETWEEN 1 AND 1000000),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  observation_sha256 TEXT NOT NULL CHECK (length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (tenant_id, observation_id),
  UNIQUE (tenant_id, request_id),
  UNIQUE (tenant_id, roof_job_id, sequence),
  UNIQUE (tenant_id, roof_job_id, area_id, revision),
  CHECK (area_sq_ft IS NOT NULL OR pitch_rise_per_12 IS NOT NULL),
  CHECK (area_sq_ft IS NOT NULL OR area_basis='unknown'),
  CHECK ((revision=1 AND supersedes_observation_id IS NULL AND correction_reason IS NULL) OR
         (revision>1 AND supersedes_observation_id IS NOT NULL AND correction_reason IS NOT NULL)),
  FOREIGN KEY (roof_job_id, tenant_id) REFERENCES operating_roof_jobs(roof_job_id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,supersedes_observation_id) REFERENCES job_manual_observations(tenant_id,observation_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,previous_head_id) REFERENCES job_manual_observations(tenant_id,observation_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_job_manual_one_successor ON job_manual_observations(tenant_id,supersedes_observation_id) WHERE supersedes_observation_id IS NOT NULL;
CREATE INDEX idx_job_manual_area ON job_manual_observations(tenant_id,roof_job_id,area_id,revision DESC);
CREATE TABLE job_manual_observation_heads (
  tenant_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  PRIMARY KEY (tenant_id,roof_job_id),
  FOREIGN KEY (tenant_id,observation_id) REFERENCES job_manual_observations(tenant_id,observation_id) ON DELETE RESTRICT
);
CREATE TABLE job_manual_measurement_receipts (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND length(input_json)<=8192),
  observation_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,request_id),
  UNIQUE (tenant_id,observation_id),
  FOREIGN KEY (tenant_id,observation_id) REFERENCES job_manual_observations(tenant_id,observation_id) ON DELETE RESTRICT
);
CREATE TRIGGER job_manual_observation_guard BEFORE INSERT ON job_manual_observations BEGIN
  SELECT RAISE(ABORT,'manual_measurement_job_stale') WHERE NOT EXISTS (SELECT 1 FROM operating_roof_jobs WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND version=NEW.job_version);
  SELECT RAISE(ABORT,'manual_measurement_record_required') WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE tenant_id=NEW.tenant_id AND user_id=NEW.recorded_by AND active=1 AND COALESCE(access_role,role) IN ('owner','ops'));
  SELECT RAISE(ABORT,'manual_measurement_head_stale') WHERE NEW.previous_head_id IS NOT (SELECT observation_id FROM job_manual_observation_heads WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id)
    OR NEW.sequence != COALESCE((SELECT version+1 FROM job_manual_observation_heads WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id),1);
  SELECT RAISE(ABORT,'manual_measurement_area_stale') WHERE NEW.revision>1 AND NOT EXISTS (SELECT 1 FROM job_manual_observations p WHERE p.tenant_id=NEW.tenant_id AND p.roof_job_id=NEW.roof_job_id AND p.observation_id=NEW.supersedes_observation_id AND p.area_id=NEW.area_id AND p.area_label=NEW.area_label AND p.revision=NEW.revision-1);
  SELECT RAISE(ABORT,'manual_measurement_area_conflict') WHERE NEW.revision=1 AND (EXISTS (SELECT 1 FROM job_manual_observations WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND (area_id=NEW.area_id OR lower(area_label)=lower(NEW.area_label))) OR
    (SELECT COUNT(*) FROM job_manual_observations WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND revision=1)>=100);
END;
CREATE TRIGGER job_manual_observation_no_replace BEFORE INSERT ON job_manual_observations WHEN EXISTS (SELECT 1 FROM job_manual_observations WHERE observation_id=NEW.observation_id OR (tenant_id=NEW.tenant_id AND request_id=NEW.request_id)) BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
CREATE TRIGGER job_manual_observation_no_update BEFORE UPDATE ON job_manual_observations BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
CREATE TRIGGER job_manual_observation_no_delete BEFORE DELETE ON job_manual_observations BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
CREATE TRIGGER job_manual_head_insert_guard BEFORE INSERT ON job_manual_observation_heads WHEN
  EXISTS (SELECT 1 FROM job_manual_observation_heads WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id) OR NEW.version!=1 OR
  NOT EXISTS (SELECT 1 FROM job_manual_observations WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND observation_id=NEW.observation_id AND sequence=1)
BEGIN SELECT RAISE(ABORT,'manual_measurement_head_stale'); END;
CREATE TRIGGER job_manual_head_update_guard BEFORE UPDATE ON job_manual_observation_heads WHEN
  NEW.tenant_id!=OLD.tenant_id OR NEW.roof_job_id!=OLD.roof_job_id OR NEW.version!=OLD.version+1 OR
  NOT EXISTS (SELECT 1 FROM job_manual_observations WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND observation_id=NEW.observation_id AND sequence=NEW.version AND previous_head_id=OLD.observation_id)
BEGIN SELECT RAISE(ABORT,'manual_measurement_head_stale'); END;
CREATE TRIGGER job_manual_head_no_delete BEFORE DELETE ON job_manual_observation_heads BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
CREATE TRIGGER job_manual_advance_head AFTER INSERT ON job_manual_observations BEGIN
  UPDATE job_manual_observation_heads SET observation_id=NEW.observation_id,version=NEW.sequence WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id;
  INSERT INTO job_manual_observation_heads SELECT NEW.tenant_id,NEW.roof_job_id,NEW.observation_id,NEW.sequence WHERE NOT EXISTS (SELECT 1 FROM job_manual_observation_heads WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id);
END;
CREATE TRIGGER job_manual_receipt_guard BEFORE INSERT ON job_manual_measurement_receipts WHEN NOT EXISTS (
 SELECT 1 FROM job_manual_observations WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND observation_id=NEW.observation_id AND request_id=NEW.request_id AND request_hash=NEW.request_hash AND recorded_by=NEW.actor_user_id AND recorded_at=NEW.recorded_at
) BEGIN SELECT RAISE(ABORT,'manual_measurement_receipt_mismatch'); END;
CREATE TRIGGER job_manual_receipt_no_replace BEFORE INSERT ON job_manual_measurement_receipts WHEN EXISTS (SELECT 1 FROM job_manual_measurement_receipts WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
CREATE TRIGGER job_manual_receipt_no_update BEFORE UPDATE ON job_manual_measurement_receipts BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
CREATE TRIGGER job_manual_receipt_no_delete BEFORE DELETE ON job_manual_measurement_receipts BEGIN SELECT RAISE(ABORT,'manual_measurement_immutable'); END;
