-- Migration 026: Internal AI Vendor Website URL
-- Additive extension for complete Admin onboarding.
-- website_url is descriptive vendor metadata; base_url remains runtime API authority.

ALTER TABLE intentchord.internal_ai_vendors
  ADD COLUMN IF NOT EXISTS website_url text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'intentchord.internal_ai_vendors'::regclass
      AND conname = 'ck_internal_ai_vendor_website_url'
  ) THEN
    ALTER TABLE intentchord.internal_ai_vendors
      ADD CONSTRAINT ck_internal_ai_vendor_website_url
      CHECK (
        website_url IS NULL
        OR (website_url ~ '^https://' AND length(website_url) <= 2048)
      );
  END IF;
END
$$;

COMMENT ON COLUMN intentchord.internal_ai_vendors.website_url IS
  'Optional human-facing Vendor website. Descriptive only; never used as runtime API endpoint authority.';
