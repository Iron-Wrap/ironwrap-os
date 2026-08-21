-- 0091_authority_readback_subject_scope.sql
--
-- Extracted from #122's 0070_authority_readback_subject_scope.sql without
-- reusing IRO-195 stack filename 0070. Additive nullable columns only.
--
ALTER TABLE authority_record_readbacks ADD COLUMN subject_type TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN subject_role TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN person_user TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN organization TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN authority_kind TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN authority_scope TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN scope_type TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN scope_ref TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN roof_job TEXT;
ALTER TABLE authority_record_readbacks ADD COLUMN scope_json TEXT;
