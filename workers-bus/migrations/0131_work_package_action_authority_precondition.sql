-- 0131_work_package_action_authority_precondition.sql
--
-- A non-stop field action is admitted only when the exact authority lifecycle
-- heads accepted by the command gate are still current in this transaction.
-- stop_work is deliberately absent: no authority state may impede a safe stop.

CREATE TRIGGER work_package_events_authority_precondition_guard
BEFORE INSERT ON work_package_events
WHEN NEW.event_kind IN ('acknowledged', 'start_work', 'complete_work')
BEGIN
  SELECT RAISE(ABORT, 'work_package_authority_precondition_stale')
  WHERE json_type(NEW.payload_json, '$.authority_preconditions') <> 'array'
     OR json_array_length(NEW.payload_json, '$.authority_preconditions') NOT BETWEEN 1 AND 20
     OR NOT EXISTS (
       SELECT 1
         FROM work_packages package
        WHERE package.tenant_id = NEW.tenant_id
          AND package.work_package_id = NEW.work_package_id
          AND package.version = NEW.work_package_version
          AND json_type(package.definition_json, '$.authority_requirements') = 'array'
          AND json_array_length(package.definition_json, '$.authority_requirements') =
              json_array_length(NEW.payload_json, '$.authority_preconditions')
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(package.definition_json, '$.authority_requirements') requirement
             WHERE NOT EXISTS (
               SELECT 1
                 FROM json_each(NEW.payload_json, '$.authority_preconditions') precondition
                WHERE json(json_extract(precondition.value, '$.requirement')) =
                      json(requirement.value)
             )
          )
     )
     OR EXISTS (
       SELECT 1
         FROM json_each(NEW.payload_json, '$.authority_preconditions') precondition
        WHERE json_type(precondition.value) <> 'object'
           OR (SELECT COUNT(*) FROM json_each(precondition.value)) <> 2
           OR EXISTS (
             SELECT 1 FROM json_each(precondition.value)
              WHERE key NOT IN ('requirement', 'current')
           )
           OR json_type(precondition.value, '$.requirement') <> 'object'
           OR json_type(precondition.value, '$.current') <> 'object'
           OR (SELECT COUNT(*) FROM json_each(precondition.value, '$.current')) <> 5
           OR EXISTS (
             SELECT 1 FROM json_each(precondition.value, '$.current')
              WHERE key NOT IN (
                'readback_id',
                'authority_record_id',
                'authority_version',
                'authority_state_digest_sha256',
                'observation_fingerprint_sha256'
              )
           )
           OR typeof(json_extract(precondition.value, '$.current.readback_id')) <> 'text'
           OR typeof(json_extract(precondition.value, '$.current.authority_record_id')) <> 'text'
           OR typeof(json_extract(precondition.value, '$.current.authority_version')) <> 'integer'
           OR json_extract(precondition.value, '$.current.authority_version') NOT BETWEEN 1 AND 1000000
           OR length(json_extract(precondition.value, '$.current.authority_state_digest_sha256')) <> 64
           OR json_extract(precondition.value, '$.current.authority_state_digest_sha256') GLOB '*[^0-9a-f]*'
           OR length(json_extract(precondition.value, '$.current.observation_fingerprint_sha256')) <> 64
           OR json_extract(precondition.value, '$.current.observation_fingerprint_sha256') GLOB '*[^0-9a-f]*'
     );

  SELECT RAISE(ABORT, 'work_package_authority_precondition_stale')
  WHERE EXISTS (
    SELECT 1
      FROM json_each(NEW.payload_json, '$.authority_preconditions') precondition
     WHERE NOT EXISTS (
       WITH RECURSIVE
       component(authority_record_id) AS (
         SELECT json_extract(
           precondition.value,
           '$.current.authority_record_id'
         )
         UNION
         SELECT readback.authority_record_id
           FROM authority_record_readbacks readback
           JOIN component
             ON readback.tenant_id = NEW.tenant_id
            AND readback.supersedes_authority_record_id = component.authority_record_id
         UNION
         SELECT readback.supersedes_authority_record_id
           FROM authority_record_readbacks readback
           JOIN component
             ON readback.tenant_id = NEW.tenant_id
            AND readback.authority_record_id = component.authority_record_id
          WHERE readback.supersedes_authority_record_id IS NOT NULL
       ),
       current_rows AS (
         SELECT candidate.*
           FROM authority_record_readbacks candidate
           JOIN component
             ON component.authority_record_id = candidate.authority_record_id
          WHERE candidate.tenant_id = NEW.tenant_id
            AND NOT EXISTS (
              SELECT 1
                FROM authority_record_readbacks newer
               WHERE newer.tenant_id = candidate.tenant_id
                 AND newer.authority_record_id = candidate.authority_record_id
                 AND (
                   newer.authority_version > candidate.authority_version
                   OR (
                     newer.authority_version = candidate.authority_version
                     AND newer.observed_at > candidate.observed_at
                   )
                   OR (
                     newer.authority_version = candidate.authority_version
                     AND newer.observed_at = candidate.observed_at
                     AND newer.readback_id > candidate.readback_id
                   )
                 )
            )
       ),
       current_heads AS (
         SELECT candidate.*
           FROM current_rows candidate
          WHERE NOT EXISTS (
            SELECT 1
              FROM current_rows successor
             WHERE successor.readback_id <> candidate.readback_id
               AND successor.supersedes_authority_record_id =
                   candidate.authority_record_id
          )
       )
       SELECT 1
         FROM authority_record_readbacks accepted
        WHERE accepted.tenant_id = NEW.tenant_id
          AND accepted.readback_id = json_extract(
            precondition.value,
            '$.current.readback_id'
          )
          AND accepted.authority_record_id = json_extract(
            precondition.value,
            '$.current.authority_record_id'
          )
          AND accepted.authority_version = json_extract(
            precondition.value,
            '$.current.authority_version'
          )
          AND accepted.authority_state_digest_sha256 = json_extract(
            precondition.value,
            '$.current.authority_state_digest_sha256'
          )
          AND accepted.observation_fingerprint_sha256 = json_extract(
            precondition.value,
            '$.current.observation_fingerprint_sha256'
          )
          AND accepted.subject_type = json_extract(
            precondition.value,
            '$.requirement.subject_type'
          )
          AND (
            (
              json_extract(precondition.value, '$.requirement.subject_type') = 'Person'
              AND accepted.person_user = json_extract(
                precondition.value,
                '$.requirement.subject_ref'
              )
            )
            OR (
              json_extract(precondition.value, '$.requirement.subject_type') = 'Organization'
              AND accepted.organization = json_extract(
                precondition.value,
                '$.requirement.subject_ref'
              )
            )
          )
          AND accepted.authority_kind = json_extract(
            precondition.value,
            '$.requirement.authority_kind'
          )
          AND accepted.scope_type = json_extract(
            precondition.value,
            '$.requirement.scope_type'
          )
          AND accepted.scope_ref = json_extract(
            precondition.value,
            '$.requirement.scope_ref'
          )
          AND (
            json_type(precondition.value, '$.requirement.authority_record_id') IS NULL
            OR accepted.authority_record_id = json_extract(
              precondition.value,
              '$.requirement.authority_record_id'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.subject_role') IS NULL
            OR accepted.subject_role = json_extract(
              precondition.value,
              '$.requirement.subject_role'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.authority_scope') IS NULL
            OR accepted.authority_scope = json_extract(
              precondition.value,
              '$.requirement.authority_scope'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.issuer_name') IS NULL
            OR accepted.issuer_name = json_extract(
              precondition.value,
              '$.requirement.issuer_name'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.issuer_jurisdiction') IS NULL
            OR accepted.issuer_jurisdiction = json_extract(
              precondition.value,
              '$.requirement.issuer_jurisdiction'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.issuer_reference') IS NULL
            OR accepted.issuer_reference = json_extract(
              precondition.value,
              '$.requirement.issuer_reference'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.source_version') IS NULL
            OR accepted.issuer_source_version = json_extract(
              precondition.value,
              '$.requirement.source_version'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.version') IS NULL
            OR accepted.authority_version = json_extract(
              precondition.value,
              '$.requirement.version'
            )
          )
          AND (
            json_type(precondition.value, '$.requirement.state_digest_sha256') IS NULL
            OR accepted.authority_state_digest_sha256 = json_extract(
              precondition.value,
              '$.requirement.state_digest_sha256'
            )
          )
          AND accepted.verification_state = 'verified'
          AND accepted.authority_revoked_at IS NULL
          AND accepted.authority_effective_from IS NOT NULL
          AND accepted.authority_expires_at IS NOT NULL
          AND accepted.authority_effective_from <= date('now')
          AND accepted.authority_expires_at >= date('now')
          AND (
            (
              accepted.authority_kind IN (
                'Trade Licence',
                'WCB Clearance',
                'Insurance Certificate',
                'Permit',
                'Inspection',
                'Manufacturer Certification',
                'Manufacturer Bulletin'
              )
              AND accepted.authority_verification_method IN (
                'Issuer Portal Readback',
                'Signed Issuer Record',
                'Regulator Readback',
                'Manufacturer Portal Readback'
              )
              AND accepted.issuer_receipt_sha256 IS NOT NULL
            )
            OR (
              accepted.authority_kind NOT IN (
                'Trade Licence',
                'WCB Clearance',
                'Insurance Certificate',
                'Permit',
                'Inspection',
                'Manufacturer Certification',
                'Manufacturer Bulletin'
              )
              AND accepted.authority_verification_method =
                  'Internal Competency Assessment'
            )
          )
          AND (
            SELECT COUNT(*)
              FROM authority_record_readbacks root
             WHERE root.tenant_id = NEW.tenant_id
               AND root.subject_type = json_extract(
                 precondition.value,
                 '$.requirement.subject_type'
               )
               AND (
                 (
                   json_extract(precondition.value, '$.requirement.subject_type') = 'Person'
                   AND root.person_user = json_extract(
                     precondition.value,
                     '$.requirement.subject_ref'
                   )
                 )
                 OR (
                   json_extract(precondition.value, '$.requirement.subject_type') = 'Organization'
                   AND root.organization = json_extract(
                     precondition.value,
                     '$.requirement.subject_ref'
                   )
                 )
               )
               AND root.authority_kind = json_extract(
                 precondition.value,
                 '$.requirement.authority_kind'
               )
               AND root.scope_type = json_extract(
                 precondition.value,
                 '$.requirement.scope_type'
               )
               AND root.scope_ref = json_extract(
                 precondition.value,
                 '$.requirement.scope_ref'
               )
               AND (
                 json_type(precondition.value, '$.requirement.authority_record_id') IS NULL
                 OR root.authority_record_id = json_extract(
                   precondition.value,
                   '$.requirement.authority_record_id'
                 )
               )
          ) BETWEEN 1 AND 32
          AND (
            SELECT COUNT(*)
              FROM authority_record_readbacks lineage
              JOIN component
                ON component.authority_record_id = lineage.authority_record_id
             WHERE lineage.tenant_id = NEW.tenant_id
          ) <= 32
          AND NOT EXISTS (
            SELECT 1
              FROM authority_record_readbacks root
             WHERE root.tenant_id = NEW.tenant_id
               AND root.subject_type = json_extract(
                 precondition.value,
                 '$.requirement.subject_type'
               )
               AND (
                 (
                   json_extract(precondition.value, '$.requirement.subject_type') = 'Person'
                   AND root.person_user = json_extract(
                     precondition.value,
                     '$.requirement.subject_ref'
                   )
                 )
                 OR (
                   json_extract(precondition.value, '$.requirement.subject_type') = 'Organization'
                   AND root.organization = json_extract(
                     precondition.value,
                     '$.requirement.subject_ref'
                   )
                 )
               )
               AND root.authority_kind = json_extract(
                 precondition.value,
                 '$.requirement.authority_kind'
               )
               AND root.scope_type = json_extract(
                 precondition.value,
                 '$.requirement.scope_type'
               )
               AND root.scope_ref = json_extract(
                 precondition.value,
                 '$.requirement.scope_ref'
               )
               AND (
                 json_type(precondition.value, '$.requirement.authority_record_id') IS NULL
                 OR root.authority_record_id = json_extract(
                   precondition.value,
                   '$.requirement.authority_record_id'
                 )
               )
               AND root.authority_record_id NOT IN (
                 SELECT authority_record_id FROM component
               )
          )
          AND NOT EXISTS (
            SELECT lineage.authority_record_id
              FROM authority_record_readbacks lineage
              JOIN component
                ON component.authority_record_id = lineage.authority_record_id
             WHERE lineage.tenant_id = NEW.tenant_id
               AND lineage.authority_version = (
               SELECT MAX(peer.authority_version)
                 FROM authority_record_readbacks peer
                WHERE peer.tenant_id = lineage.tenant_id
                  AND peer.authority_record_id = lineage.authority_record_id
             )
             GROUP BY lineage.authority_record_id
            HAVING COUNT(DISTINCT lineage.authority_state_digest_sha256) > 1
          )
          AND (SELECT COUNT(*) FROM current_heads) = 1
          AND EXISTS (
            SELECT 1
              FROM current_heads head
             WHERE head.readback_id = accepted.readback_id
          )
     )
  );
END;
