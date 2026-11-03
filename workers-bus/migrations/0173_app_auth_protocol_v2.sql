-- Operating-plane allocation. Expand only: P0 credentials/rollback remain valid at floor one.
-- No enrollment, issuer activation, credential retirement or provider action runs here.
CREATE TABLE app_auth_protocol (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  protocol_floor INTEGER NOT NULL CHECK (protocol_floor IN (1,2)),
  mode TEXT NOT NULL CHECK (mode IN ('staged','closed','active')),
  control_revision INTEGER NOT NULL CHECK (typeof(control_revision)='integer' AND control_revision BETWEEN 0 AND 9007199254740991),
  issuer TEXT,
  activation_id TEXT,
  database_identity TEXT,
  enrollment_open INTEGER NOT NULL DEFAULT 0 CHECK (enrollment_open IN (0,1)),
  CHECK (mode != 'staged' OR protocol_floor = 1),
  CHECK (mode != 'active' OR protocol_floor = 2),
  CHECK (enrollment_open = 0 OR (mode = 'active' AND protocol_floor = 2)),
  CHECK (protocol_floor = 1 OR
    (issuer IS NOT NULL AND activation_id IS NOT NULL AND database_identity IS NOT NULL))
);
INSERT INTO app_auth_protocol VALUES (1,1,'staged',0,NULL,NULL,NULL,0);

CREATE TRIGGER app_auth_v2_protocol_no_delete BEFORE DELETE ON app_auth_protocol
BEGIN SELECT RAISE(ABORT,'auth_protocol_tombstone'); END;
CREATE TRIGGER app_auth_v2_protocol_monotonic BEFORE UPDATE ON app_auth_protocol
WHEN NEW.singleton != OLD.singleton OR NEW.protocol_floor < OLD.protocol_floor
  OR NEW.control_revision < OLD.control_revision
  OR (OLD.protocol_floor = 2 AND
      (NEW.mode = 'staged' OR NEW.issuer IS NOT OLD.issuer
       OR NEW.activation_id IS NOT OLD.activation_id
       OR NEW.database_identity IS NOT OLD.database_identity))
BEGIN SELECT RAISE(ABORT,'auth_protocol_floor'); END;

CREATE TABLE app_auth_contexts (
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  generation INTEGER NOT NULL CHECK (typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
  current_session_hash TEXT,
  transition_marker TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,issuer,context_hash),
  CHECK (generation != 0 OR current_session_hash IS NULL)
);
CREATE INDEX idx_app_auth_contexts_pointer ON app_auth_contexts (current_session_hash);
CREATE TRIGGER app_auth_v2_context_no_delete BEFORE DELETE ON app_auth_contexts
BEGIN SELECT RAISE(ABORT,'auth_context_tombstone'); END;
CREATE TRIGGER app_auth_v2_context_insert BEFORE INSERT ON app_auth_contexts
WHEN NEW.generation != 0 OR NEW.current_session_hash IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND protocol_floor=2
    AND mode='active' AND issuer=NEW.issuer AND enrollment_open=1)
BEGIN SELECT RAISE(ABORT,'auth_context_creation'); END;
CREATE TRIGGER app_auth_v2_context_monotonic BEFORE UPDATE ON app_auth_contexts
WHEN NEW.tenant_id != OLD.tenant_id OR NEW.issuer != OLD.issuer OR NEW.context_hash != OLD.context_hash
  OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation+1
  OR (NEW.generation = OLD.generation AND NEW.current_session_hash IS NOT OLD.current_session_hash)
  OR (NEW.generation != OLD.generation AND NOT EXISTS (
    SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND protocol_floor=2 AND issuer=NEW.issuer
      AND (mode='active' OR NEW.current_session_hash IS NULL)))
BEGIN SELECT RAISE(ABORT,'auth_context_generation'); END;

CREATE TABLE app_auth_issuance (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  issuer TEXT,
  sequence INTEGER NOT NULL CHECK (typeof(sequence)='integer' AND sequence BETWEEN 0 AND 9007199254740991),
  execution_marker TEXT NOT NULL
);
INSERT INTO app_auth_issuance VALUES (1,NULL,0,'uninitialized');
CREATE TRIGGER app_auth_v2_issuance_no_delete BEFORE DELETE ON app_auth_issuance
BEGIN SELECT RAISE(ABORT,'auth_issuance_tombstone'); END;
CREATE TRIGGER app_auth_v2_issuance_monotonic BEFORE UPDATE ON app_auth_issuance
WHEN NEW.singleton != OLD.singleton OR NOT (
  (NEW.issuer IS OLD.issuer AND NEW.sequence=OLD.sequence AND NEW.execution_marker=OLD.execution_marker)
  OR
  (OLD.issuer IS NULL AND OLD.sequence=0 AND NEW.sequence=0 AND EXISTS (
    SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND protocol_floor=2 AND issuer=NEW.issuer))
  OR (NEW.issuer=OLD.issuer AND NEW.sequence=OLD.sequence+1 AND EXISTS (
    SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND protocol_floor=2 AND mode='active' AND issuer=NEW.issuer)))
BEGIN SELECT RAISE(ABORT,'auth_issuance_sequence'); END;

CREATE TABLE app_auth_enrollment_intents (
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  intent_id TEXT NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 128),
  challenge TEXT NOT NULL CHECK (length(challenge)=43),
  base_generation INTEGER NOT NULL CHECK (typeof(base_generation)='integer' AND base_generation BETWEEN 0 AND 9007199254740991),
  issue_floor INTEGER NOT NULL CHECK (typeof(issue_floor)='integer' AND issue_floor BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,issuer,context_hash,intent_id),
  UNIQUE (challenge),
  FOREIGN KEY (tenant_id,issuer,context_hash) REFERENCES app_auth_contexts(tenant_id,issuer,context_hash)
);
CREATE TRIGGER app_auth_v2_intent_no_update BEFORE UPDATE ON app_auth_enrollment_intents
BEGIN SELECT RAISE(ABORT,'auth_intent_immutable'); END;
CREATE TRIGGER app_auth_v2_intent_no_delete BEFORE DELETE ON app_auth_enrollment_intents
BEGIN SELECT RAISE(ABORT,'auth_intent_tombstone'); END;

ALTER TABLE app_sessions ADD COLUMN auth_protocol INTEGER NOT NULL DEFAULT 1 CHECK (auth_protocol IN (1,2));
ALTER TABLE app_sessions ADD COLUMN auth_issuer TEXT;
ALTER TABLE app_sessions ADD COLUMN auth_context_hash TEXT;
ALTER TABLE app_sessions ADD COLUMN auth_context_generation INTEGER CHECK (auth_context_generation IS NULL OR
  (typeof(auth_context_generation)='integer' AND auth_context_generation BETWEEN 0 AND 9007199254740991));
CREATE UNIQUE INDEX idx_app_sessions_auth_generation
  ON app_sessions (tenant_id,auth_issuer,auth_context_hash,auth_context_generation)
  WHERE auth_protocol=2;
ALTER TABLE app_magic_links ADD COLUMN auth_protocol INTEGER NOT NULL DEFAULT 1 CHECK (auth_protocol IN (1,2));
ALTER TABLE app_magic_links ADD COLUMN auth_issuer TEXT;
ALTER TABLE app_magic_links ADD COLUMN issue_sequence INTEGER;
ALTER TABLE app_magic_links ADD COLUMN claim_marker TEXT;
ALTER TABLE app_device_pairings ADD COLUMN auth_protocol INTEGER NOT NULL DEFAULT 1 CHECK (auth_protocol IN (1,2));
ALTER TABLE app_device_pairings ADD COLUMN auth_issuer TEXT;
ALTER TABLE app_device_pairings ADD COLUMN issue_sequence INTEGER;
ALTER TABLE app_device_pairings ADD COLUMN claim_marker TEXT;

CREATE TRIGGER app_auth_v2_session_insert BEFORE INSERT ON app_sessions
WHEN (SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1)=2 AND (
  NEW.auth_protocol!=2 OR NOT EXISTS (
    SELECT 1 FROM app_auth_protocol p JOIN app_auth_contexts c
      ON c.issuer=p.issuer AND c.tenant_id=NEW.tenant_id AND c.context_hash=NEW.auth_context_hash
     WHERE p.singleton=1 AND p.mode='active' AND NEW.auth_issuer=p.issuer
       AND c.generation=NEW.auth_context_generation AND c.current_session_hash=NEW.session_hash))
BEGIN SELECT RAISE(ABORT,'auth_session_floor'); END;
CREATE TRIGGER app_auth_v2_session_immutable BEFORE UPDATE ON app_sessions
WHEN (SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1)=2 AND (
  (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)
  OR (NEW.auth_protocol!=2 AND NEW.revoked_at IS NULL)
  OR NEW.session_hash!=OLD.session_hash OR NEW.user_id!=OLD.user_id OR NEW.tenant_id!=OLD.tenant_id
  OR NEW.device_id IS NOT OLD.device_id OR NEW.auth_protocol!=OLD.auth_protocol
  OR NEW.auth_issuer IS NOT OLD.auth_issuer OR NEW.auth_context_hash IS NOT OLD.auth_context_hash
  OR NEW.expires_at>OLD.expires_at
  OR (NEW.auth_context_generation IS NOT OLD.auth_context_generation AND NOT EXISTS (
    SELECT 1 FROM app_auth_contexts c WHERE c.tenant_id=NEW.tenant_id AND c.issuer=NEW.auth_issuer
      AND c.context_hash=NEW.auth_context_hash AND c.current_session_hash=NEW.session_hash
      AND c.generation=NEW.auth_context_generation AND NEW.revoked_at IS NULL)))
BEGIN SELECT RAISE(ABORT,'auth_session_revival'); END;

CREATE TRIGGER app_auth_v2_session_revoke AFTER UPDATE OF revoked_at ON app_sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND OLD.auth_protocol=2
BEGIN
  UPDATE app_auth_contexts SET generation=generation+1,current_session_hash=NULL,
    transition_marker=lower(hex(randomblob(24))),updated_at=NEW.revoked_at
   WHERE tenant_id=OLD.tenant_id AND issuer=OLD.auth_issuer AND context_hash=OLD.auth_context_hash
     AND current_session_hash=OLD.session_hash;
END;
CREATE TRIGGER app_auth_v2_session_delete BEFORE DELETE ON app_sessions WHEN OLD.auth_protocol=2
BEGIN
  UPDATE app_auth_contexts SET generation=generation+1,current_session_hash=NULL,
    transition_marker=lower(hex(randomblob(24))),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE tenant_id=OLD.tenant_id AND issuer=OLD.auth_issuer AND context_hash=OLD.auth_context_hash
     AND current_session_hash=OLD.session_hash;
END;
CREATE TRIGGER app_auth_v2_device_withdraw AFTER UPDATE OF revoked_at,device_proof_hash,user_id,tenant_id,device_id ON app_devices
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR NEW.device_proof_hash!=OLD.device_proof_hash
  OR NEW.user_id!=OLD.user_id OR NEW.tenant_id!=OLD.tenant_id OR NEW.device_id!=OLD.device_id
BEGIN
  UPDATE app_sessions SET revoked_at=COALESCE(NEW.revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE tenant_id=OLD.tenant_id AND device_id=OLD.device_id AND revoked_at IS NULL AND auth_protocol=2;
END;
CREATE TRIGGER app_auth_v2_device_delete BEFORE DELETE ON app_devices
BEGIN
  UPDATE app_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE tenant_id=OLD.tenant_id AND device_id=OLD.device_id AND revoked_at IS NULL AND auth_protocol=2;
END;
CREATE TRIGGER app_auth_v2_access_withdraw AFTER UPDATE OF active ON app_users
WHEN OLD.active=1 AND NEW.active=0
BEGIN
  UPDATE app_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND revoked_at IS NULL AND auth_protocol=2;
END;
CREATE TRIGGER app_auth_v2_live_role AFTER UPDATE OF access_role ON app_users
WHEN OLD.access_role!=NEW.access_role AND NEW.active=1
BEGIN
  UPDATE app_auth_contexts SET generation=generation+1,
    current_session_hash=CASE WHEN EXISTS (
      SELECT 1 FROM app_sessions s LEFT JOIN app_devices d ON d.device_id=s.device_id AND d.tenant_id=s.tenant_id
       WHERE s.session_hash=app_auth_contexts.current_session_hash AND s.tenant_id=NEW.tenant_id
         AND s.user_id=NEW.user_id AND s.revoked_at IS NULL
         AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND (NEW.access_role!='field' OR (d.device_id IS NOT NULL AND d.revoked_at IS NULL))
         AND EXISTS (SELECT 1 FROM app_auth_protocol WHERE singleton=1 AND mode='active'))
      THEN current_session_hash ELSE NULL END,
    transition_marker=lower(hex(randomblob(24))),updated_at=NEW.updated_at
   WHERE current_session_hash IN (SELECT session_hash FROM app_sessions
     WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id AND auth_protocol=2);
  UPDATE app_sessions SET auth_context_generation=(SELECT c.generation FROM app_auth_contexts c
    WHERE c.tenant_id=app_sessions.tenant_id AND c.issuer=app_sessions.auth_issuer
      AND c.context_hash=app_sessions.auth_context_hash AND c.current_session_hash=app_sessions.session_hash)
   WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id AND auth_protocol=2
     AND revoked_at IS NULL AND session_hash IN (SELECT current_session_hash FROM app_auth_contexts);
END;

CREATE TRIGGER app_auth_v2_magic_insert BEFORE INSERT ON app_magic_links
WHEN (SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1)=2 AND (
  NEW.auth_protocol!=2 OR NEW.issue_sequence IS NULL OR NEW.issue_sequence<1 OR NOT EXISTS (
    SELECT 1 FROM app_auth_issuance i JOIN app_auth_protocol p ON p.issuer=i.issuer
     WHERE i.singleton=1 AND p.singleton=1 AND p.mode='active'
       AND NEW.auth_issuer=i.issuer AND NEW.issue_sequence=i.sequence))
BEGIN SELECT RAISE(ABORT,'auth_grant_floor'); END;
CREATE TRIGGER app_auth_v2_magic_replace BEFORE UPDATE ON app_magic_links
WHEN (SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1)=2 AND (
  (NEW.token_hash!=OLD.token_hash AND (NEW.auth_protocol!=2 OR (OLD.auth_protocol=2 AND NEW.auth_issuer IS NOT OLD.auth_issuer)
    OR NEW.issue_sequence IS NULL OR NEW.issue_sequence<=COALESCE(OLD.issue_sequence,0)
    OR NEW.issue_sequence!=(SELECT sequence FROM app_auth_issuance WHERE singleton=1)))
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL AND NEW.token_hash=OLD.token_hash))
BEGIN SELECT RAISE(ABORT,'auth_grant_revival'); END;
CREATE TRIGGER app_auth_v2_pair_insert BEFORE INSERT ON app_device_pairings
WHEN (SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1)=2 AND (
  NEW.auth_protocol!=2 OR NEW.issue_sequence IS NULL OR NEW.issue_sequence<1 OR NOT EXISTS (
    SELECT 1 FROM app_auth_issuance i JOIN app_auth_protocol p ON p.issuer=i.issuer
     WHERE i.singleton=1 AND p.singleton=1 AND p.mode='active'
       AND NEW.auth_issuer=i.issuer AND NEW.issue_sequence=i.sequence))
BEGIN SELECT RAISE(ABORT,'auth_grant_floor'); END;
CREATE TRIGGER app_auth_v2_pair_immutable BEFORE UPDATE ON app_device_pairings
WHEN (SELECT protocol_floor FROM app_auth_protocol WHERE singleton=1)=2 AND (
  NEW.token_hash!=OLD.token_hash OR NEW.auth_protocol!=OLD.auth_protocol
  OR NEW.auth_issuer IS NOT OLD.auth_issuer OR NEW.issue_sequence IS NOT OLD.issue_sequence
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'auth_grant_revival'); END;

-- One statement is the cutover transaction. A remote SQL-file runner need not supply a
-- JavaScript batch or an unsupported BEGIN: all retirement/guards/audit are database-owned.
CREATE TRIGGER app_auth_v2_cutover_closed BEFORE UPDATE OF protocol_floor ON app_auth_protocol
WHEN OLD.protocol_floor=1 AND NEW.protocol_floor=2 AND (NEW.mode!='closed' OR NEW.enrollment_open!=0)
BEGIN SELECT RAISE(ABORT,'auth_cutover_requires_closed'); END;
CREATE TRIGGER app_auth_v2_cutover AFTER UPDATE OF protocol_floor ON app_auth_protocol
WHEN OLD.protocol_floor=1 AND NEW.protocol_floor=2
BEGIN
  UPDATE app_sessions SET revoked_at=MAX(created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE revoked_at IS NULL;
  UPDATE app_magic_links SET consumed_at=MAX(created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE consumed_at IS NULL;
  UPDATE app_device_pairings SET revoked_at=MAX(created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE consumed_at IS NULL AND revoked_at IS NULL;
  UPDATE app_auth_issuance SET issuer=NEW.issuer WHERE singleton=1 AND issuer IS NULL AND sequence=0;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM app_auth_issuance WHERE singleton=1 AND issuer=NEW.issuer)
    OR EXISTS (SELECT 1 FROM app_sessions WHERE revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM app_magic_links WHERE consumed_at IS NULL)
    OR EXISTS (SELECT 1 FROM app_device_pairings WHERE consumed_at IS NULL AND revoked_at IS NULL)
    THEN RAISE(ABORT,'auth_cutover_incomplete') END;
  INSERT INTO app_auth_audit (created_at,tenant_id,user_id,event,outcome,ip_hash,user_agent_hash,detail_code)
    VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,'auth_protocol_cutover','legacy_retired',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000000','v2');
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'auth_cutover_audit_missing') END;
END;
