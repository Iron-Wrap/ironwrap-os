-- Private report evidence and human adjudication. No geometry or commercial authority.
CREATE TABLE job_measurement_reports (
 report_id TEXT PRIMARY KEY CHECK(length(report_id)=69 AND report_id GLOB 'mrpt_*' AND substr(report_id,6) NOT GLOB '*[^0-9a-f]*'),
 tenant_id TEXT NOT NULL, roof_job_id TEXT NOT NULL, job_version INTEGER NOT NULL CHECK(job_version BETWEEN 1 AND 1000000),
 uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL, stored_at TEXT,
 file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180), content_type TEXT NOT NULL CHECK(content_type='application/pdf'),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 5 AND 20971520), sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'), r2_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('awaiting_bytes','stored')), UNIQUE(tenant_id,report_id),
 CHECK((state='stored')=(stored_at IS NOT NULL)),
 FOREIGN KEY(roof_job_id,tenant_id) REFERENCES operating_roof_jobs(roof_job_id,tenant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_job_reports_list ON job_measurement_reports(tenant_id,roof_job_id,report_id DESC);
CREATE TABLE job_measurement_report_events (
 event_id TEXT PRIMARY KEY CHECK(length(event_id)=69 AND event_id GLOB 'mrce_*' AND substr(event_id,6) NOT GLOB '*[^0-9a-f]*'),
 tenant_id TEXT NOT NULL, roof_job_id TEXT NOT NULL, report_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('candidate_set','review')),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 1000000), previous_head_id TEXT, job_version INTEGER NOT NULL,
 recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=65536),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,report_id,sequence),
 FOREIGN KEY(tenant_id,report_id) REFERENCES job_measurement_reports(tenant_id,report_id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,previous_head_id) REFERENCES job_measurement_report_events(tenant_id,event_id) ON DELETE RESTRICT
);
CREATE INDEX idx_job_report_event_kind ON job_measurement_report_events(tenant_id,report_id,kind,sequence DESC);
CREATE TABLE job_measurement_report_heads (
 tenant_id TEXT NOT NULL, report_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,report_id), FOREIGN KEY(tenant_id,event_id) REFERENCES job_measurement_report_events(tenant_id,event_id) ON DELETE RESTRICT
);
CREATE TABLE job_measurement_report_receipts (
 tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, roof_job_id TEXT NOT NULL, report_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('upload','candidate_set','review')),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'), input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(input_json)<=65536), event_id TEXT, recorded_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,request_id), UNIQUE(tenant_id,event_id), CHECK((kind='upload')=(event_id IS NULL)),
 FOREIGN KEY(tenant_id,report_id) REFERENCES job_measurement_reports(tenant_id,report_id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,event_id) REFERENCES job_measurement_report_events(tenant_id,event_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_job_report_upload_receipt ON job_measurement_report_receipts(tenant_id,report_id) WHERE kind='upload';
CREATE TRIGGER job_report_insert_guard BEFORE INSERT ON job_measurement_reports BEGIN
 SELECT RAISE(ABORT,'report_job_stale') WHERE NEW.state!='awaiting_bytes' OR NOT EXISTS(SELECT 1 FROM operating_roof_jobs WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND version=NEW.job_version);
 SELECT RAISE(ABORT,'report_write_required') WHERE NOT EXISTS(SELECT 1 FROM app_users WHERE tenant_id=NEW.tenant_id AND user_id=NEW.uploaded_by AND active=1 AND COALESCE(access_role,role) IN ('owner','ops'));
END;
CREATE TRIGGER job_report_store_actor_guard BEFORE UPDATE ON job_measurement_reports WHEN NOT EXISTS(SELECT 1 FROM app_users WHERE tenant_id=NEW.tenant_id AND user_id=NEW.uploaded_by AND active=1 AND COALESCE(access_role,role) IN ('owner','ops')) BEGIN SELECT RAISE(ABORT,'report_write_required'); END;
CREATE TRIGGER job_report_store_guard BEFORE UPDATE ON job_measurement_reports WHEN
 NEW.report_id!=OLD.report_id OR NEW.tenant_id!=OLD.tenant_id OR NEW.roof_job_id!=OLD.roof_job_id OR NEW.job_version!=OLD.job_version OR NEW.uploaded_by!=OLD.uploaded_by OR NEW.created_at!=OLD.created_at OR NEW.file_name!=OLD.file_name OR NEW.content_type!=OLD.content_type OR NEW.size_bytes!=OLD.size_bytes OR NEW.sha256!=OLD.sha256 OR NEW.r2_key!=OLD.r2_key OR OLD.state!='awaiting_bytes' OR NEW.state!='stored' OR NEW.stored_at IS NULL
 BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_report_event_guard BEFORE INSERT ON job_measurement_report_events BEGIN
 SELECT RAISE(ABORT,'report_not_stored') WHERE NOT EXISTS(SELECT 1 FROM job_measurement_reports WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND report_id=NEW.report_id AND state='stored');
 SELECT RAISE(ABORT,'report_job_stale') WHERE NOT EXISTS(SELECT 1 FROM operating_roof_jobs WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND version=NEW.job_version);
 SELECT RAISE(ABORT,'report_write_required') WHERE NOT EXISTS(SELECT 1 FROM app_users WHERE tenant_id=NEW.tenant_id AND user_id=NEW.recorded_by AND active=1 AND COALESCE(access_role,role) IN ('owner','ops'));
 SELECT RAISE(ABORT,'report_head_stale') WHERE NEW.previous_head_id IS NOT(SELECT event_id FROM job_measurement_report_heads WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id) OR NEW.sequence!=COALESCE((SELECT sequence+1 FROM job_measurement_report_heads WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id),1);
 SELECT RAISE(ABORT,'report_event_mismatch') WHERE json_type(NEW.payload_json) IS NOT 'object' OR
  json_type(NEW.payload_json,'$.id') IS NOT 'text' OR
  json_type(NEW.payload_json,'$.job_id') IS NOT 'text' OR
  json_type(NEW.payload_json,'$.report_id') IS NOT 'text' OR
  json_type(NEW.payload_json,'$.kind') IS NOT 'text' OR
  json_type(NEW.payload_json,'$.recorded_by') IS NOT 'text' OR
  json_type(NEW.payload_json,'$.sequence') IS NOT 'integer' OR
  json_type(NEW.payload_json,'$.job_version') IS NOT 'integer' OR
  json_type(NEW.payload_json,'$.recorded_at') IS NOT 'text' OR
  json_type(NEW.payload_json,'$.previous_head_id') IS NOT
   CASE WHEN NEW.previous_head_id IS NULL THEN 'null' ELSE 'text' END OR
  json_extract(NEW.payload_json,'$.id') IS NOT NEW.event_id OR
  json_extract(NEW.payload_json,'$.job_id') IS NOT NEW.roof_job_id OR
  json_extract(NEW.payload_json,'$.report_id') IS NOT NEW.report_id OR
  json_extract(NEW.payload_json,'$.kind') IS NOT NEW.kind OR
  json_extract(NEW.payload_json,'$.recorded_by') IS NOT NEW.recorded_by OR
  json_extract(NEW.payload_json,'$.sequence') IS NOT NEW.sequence OR
  json_extract(NEW.payload_json,'$.job_version') IS NOT NEW.job_version OR
  json_extract(NEW.payload_json,'$.recorded_at') IS NOT NEW.recorded_at OR
  json_extract(NEW.payload_json,'$.previous_head_id') IS NOT NEW.previous_head_id;
END;
CREATE TRIGGER job_report_head_insert_guard BEFORE INSERT ON job_measurement_report_heads WHEN
 EXISTS(SELECT 1 FROM job_measurement_report_heads WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id) OR NEW.sequence!=1 OR NOT EXISTS(SELECT 1 FROM job_measurement_report_events WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id AND event_id=NEW.event_id AND sequence=1)
 BEGIN SELECT RAISE(ABORT,'report_head_stale'); END;
CREATE TRIGGER job_report_head_update_guard BEFORE UPDATE ON job_measurement_report_heads WHEN
 NEW.tenant_id!=OLD.tenant_id OR NEW.report_id!=OLD.report_id OR NEW.sequence!=OLD.sequence+1 OR NOT EXISTS(SELECT 1 FROM job_measurement_report_events WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id AND event_id=NEW.event_id AND sequence=NEW.sequence AND previous_head_id=OLD.event_id)
 BEGIN SELECT RAISE(ABORT,'report_head_stale'); END;
CREATE TRIGGER job_report_advance_head AFTER INSERT ON job_measurement_report_events BEGIN
 UPDATE job_measurement_report_heads SET event_id=NEW.event_id,sequence=NEW.sequence WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id;
 INSERT INTO job_measurement_report_heads SELECT NEW.tenant_id,NEW.report_id,NEW.event_id,NEW.sequence WHERE NOT EXISTS(SELECT 1 FROM job_measurement_report_heads WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id);
END;
CREATE TRIGGER job_report_receipt_guard BEFORE INSERT ON job_measurement_report_receipts BEGIN
 SELECT RAISE(ABORT,'report_receipt_mismatch') WHERE NOT EXISTS(SELECT 1 FROM job_measurement_reports WHERE tenant_id=NEW.tenant_id AND roof_job_id=NEW.roof_job_id AND report_id=NEW.report_id);
 SELECT RAISE(ABORT,'report_receipt_mismatch') WHERE NEW.kind='upload' AND NOT EXISTS(SELECT 1 FROM job_measurement_reports WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id AND uploaded_by=NEW.actor_user_id AND created_at=NEW.recorded_at);
 SELECT RAISE(ABORT,'report_receipt_mismatch') WHERE NEW.kind!='upload' AND NOT EXISTS(SELECT 1 FROM job_measurement_report_events WHERE tenant_id=NEW.tenant_id AND report_id=NEW.report_id AND event_id=NEW.event_id AND kind=NEW.kind AND recorded_by=NEW.actor_user_id AND recorded_at=NEW.recorded_at);
END;
CREATE TRIGGER job_measurement_reports_no_replace BEFORE INSERT ON job_measurement_reports WHEN EXISTS(SELECT 1 FROM job_measurement_reports WHERE report_id=NEW.report_id) BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_events_no_replace BEFORE INSERT ON job_measurement_report_events WHEN EXISTS(SELECT 1 FROM job_measurement_report_events WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_receipts_no_replace BEFORE INSERT ON job_measurement_report_receipts WHEN EXISTS(SELECT 1 FROM job_measurement_report_receipts WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_reports_no_delete BEFORE DELETE ON job_measurement_reports BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_events_no_update BEFORE UPDATE ON job_measurement_report_events BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_events_no_delete BEFORE DELETE ON job_measurement_report_events BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_receipts_no_update BEFORE UPDATE ON job_measurement_report_receipts BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_receipts_no_delete BEFORE DELETE ON job_measurement_report_receipts BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
CREATE TRIGGER job_measurement_report_heads_no_delete BEFORE DELETE ON job_measurement_report_heads BEGIN SELECT RAISE(ABORT,'report_immutable'); END;
