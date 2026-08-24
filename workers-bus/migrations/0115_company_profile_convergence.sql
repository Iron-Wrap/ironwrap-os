-- 0115_company_profile_convergence.sql
-- Converge the public-branding fields and logo metadata from the retired R2
-- company-profile document into the versioned D1 company profile. R2 remains
-- the byte store for uploaded logos; D1 is the only profile source of truth.

ALTER TABLE tenant_company_profiles
  ADD COLUMN service_area TEXT NOT NULL DEFAULT ''
  CHECK (length(trim(service_area)) BETWEEN 0 AND 120);

ALTER TABLE tenant_company_profiles
  ADD COLUMN email TEXT NOT NULL DEFAULT ''
  CHECK (length(trim(email)) BETWEEN 0 AND 160);

ALTER TABLE tenant_company_profiles
  ADD COLUMN website TEXT NOT NULL DEFAULT ''
  CHECK (length(trim(website)) BETWEEN 0 AND 200);

ALTER TABLE tenant_company_profiles
  ADD COLUMN address_line2 TEXT NOT NULL DEFAULT ''
  CHECK (length(trim(address_line2)) BETWEEN 0 AND 160);

ALTER TABLE tenant_company_profiles
  ADD COLUMN country TEXT NOT NULL DEFAULT ''
  CHECK (length(trim(country)) BETWEEN 0 AND 80);

ALTER TABLE tenant_company_profiles
  ADD COLUMN brand_labels_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(brand_labels_json) AND json_type(brand_labels_json) = 'object');

ALTER TABLE tenant_company_profiles
  ADD COLUMN logo_content_type TEXT
  CHECK (logo_content_type IS NULL OR logo_content_type IN (
    'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'
  ));

ALTER TABLE tenant_company_profiles
  ADD COLUMN logo_byte_size INTEGER
  CHECK (logo_byte_size IS NULL OR logo_byte_size BETWEEN 1 AND 524288);

ALTER TABLE tenant_company_profiles
  ADD COLUMN logo_version TEXT
  CHECK (logo_version IS NULL OR (
    length(logo_version) = 32
    AND logo_version NOT GLOB '*[^0-9a-f]*'
  ));

ALTER TABLE tenant_company_profiles
  ADD COLUMN logo_updated_at TEXT
  CHECK (logo_updated_at IS NULL OR length(logo_updated_at) BETWEEN 20 AND 40);
