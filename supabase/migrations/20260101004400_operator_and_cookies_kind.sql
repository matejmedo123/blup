-- ---------------------------------------------------------------------------
-- Who runs this, and a place to say what the cookies do.
--
-- Two things a public website needs and BLUP had nowhere to put:
--
--   · the operator's identity — legal name, address, IČO, contact — which
--     belongs in the footer of every page and, in the EU, is not optional
--   · a cookie policy, alongside the terms and the privacy notice
--
-- The identity lives in platform_settings, which is already world-readable and
-- admin-writable, so the footer is filled in from the admin screen rather than
-- hardcoded into a build. Nothing here invents a company: the columns start
-- empty, and the footer shows only what has actually been filled in.
--
-- The enum value has to be added in its own migration — Postgres will not let a
-- value be used in the same transaction that adds it, and the seed is next.
-- ---------------------------------------------------------------------------

alter table public.platform_settings
  add column if not exists operator_name        text,
  add column if not exists operator_address     text,
  add column if not exists operator_city        text,
  add column if not exists operator_country     text,
  add column if not exists operator_reg_no      text,
  add column if not exists operator_vat_no      text,
  add column if not exists operator_email       text,
  add column if not exists operator_phone       text,
  add column if not exists operator_website     text;

comment on column public.platform_settings.operator_name is
  'Legal name of whoever runs this deployment. Shown in the site footer.';
comment on column public.platform_settings.operator_reg_no is
  'IČO / company registration number.';
comment on column public.platform_settings.operator_vat_no is
  'DIČ / IČ DPH.';

alter type legal_document_kind add value if not exists 'cookies';
