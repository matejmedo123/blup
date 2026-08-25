-- ============================================================================
-- BLUP test 17 · Legal documents, and proof of who agreed to what
-- ============================================================================
-- What is actually being proved here:
--
--   · the four documents ship published, so a fresh deployment can sell
--   · published text cannot be edited — a new version is the only way to change
--   · an acceptance points at one exact version
--   · accepting twice keeps the first timestamp, not the latest
--   · only an admin can countersign, and countersigning is not repeatable
--   · nobody can forge an acceptance by writing the table directly
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1717171-0000-0000-0000-000000000001', 'org17@example.com',   '{"display_name":"Org"}'),
  ('a1717171-0000-0000-0000-000000000002', 'admin17@example.com', '{"display_name":"Admin"}');

update public.profiles set app_role = 'admin' where id = 'a1717171-0000-0000-0000-000000000002';

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('d1717171-0000-0000-0000-000000000001', 'Legal Co', 'legal-co-17',
        'a1717171-0000-0000-0000-000000000001', 'pending');

do $$
declare
  org_user uuid := 'a1717171-0000-0000-0000-000000000001';
  admin    uuid := 'a1717171-0000-0000-0000-000000000002';
  v_doc    public.legal_documents;
  v_acc    public.legal_acceptances;
  v_again  public.legal_acceptances;
  n integer;
begin
  -- ---- shipped and published ----------------------------------------------
  select count(*) into n from public.legal_documents where published_at is not null;
  assert n = 4, format('four documents should ship published, found %s', n);

  -- The cookie policy is one of them: a public site that stores anything in a
  -- browser has to say what and why, and it must be there before launch, not
  -- after somebody asks.
  assert exists (
    select 1 from public.legal_documents
     where kind = 'cookies' and locale = 'sk' and published_at is not null
  ), 'the cookie policy ships published';
  raise notice 'PASS all four documents ship published';

  v_doc := public.current_legal_document('organizer_agreement', 'sk');
  assert v_doc.id is not null, 'the live agreement resolves';
  assert v_doc.version = '1.0', format('got version %s', v_doc.version);

  -- ---- published text is frozen -------------------------------------------
  begin
    update public.legal_documents set body = 'nieco ine' where id = v_doc.id;
    assert false, 'published text must not be editable';
  exception when others then
    assert sqlerrm = 'LEGAL_DOCUMENT_PUBLISHED',
      format('expected LEGAL_DOCUMENT_PUBLISHED, got %s', sqlerrm);
  end;
  raise notice 'PASS published text cannot be edited, only superseded';

  -- ---- accepting -----------------------------------------------------------
  perform set_config('request.jwt.claim.sub', org_user::text, true);
  v_acc := public.accept_legal_document(v_doc.id, 'd1717171-0000-0000-0000-000000000001');
  assert v_acc.document_id = v_doc.id, 'the acceptance names the exact version';
  assert v_acc.countersigned_at is null, 'and is not signed by BLUP yet';
  raise notice 'PASS an acceptance points at one exact version';

  -- ---- accepting again keeps the first time --------------------------------
  perform pg_sleep(0.05);
  v_again := public.accept_legal_document(v_doc.id, 'd1717171-0000-0000-0000-000000000001');
  assert v_again.id = v_acc.id, 'the same acceptance is returned';
  assert v_again.accepted_at = v_acc.accepted_at,
    'and keeps the original timestamp rather than moving to now';
  raise notice 'PASS re-accepting keeps the moment it was first agreed';

  -- ---- an unpublished document cannot be accepted --------------------------
  insert into public.legal_documents (kind, version, locale, title, body)
  values ('terms', '2.0-draft', 'sk', 'Koncept',
          repeat('Toto je koncept, ktory este nie je zverejneny. ', 5));
  begin
    perform public.accept_legal_document(
      (select id from public.legal_documents where version = '2.0-draft'));
    assert false, 'a draft must not be acceptable';
  exception when others then
    assert sqlerrm = 'DOCUMENT_NOT_PUBLISHED',
      format('expected DOCUMENT_NOT_PUBLISHED, got %s', sqlerrm);
  end;
  raise notice 'PASS a draft cannot be agreed to';

  -- ---- only an admin countersigns -----------------------------------------
  begin
    perform public.countersign_agreement(v_acc.id);
    assert false, 'an organizer must not countersign on behalf of BLUP';
  exception when others then
    assert sqlerrm = 'NOT_AUTHORIZED', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;

  perform set_config('request.jwt.claim.sub', admin::text, true);
  v_again := public.countersign_agreement(v_acc.id);
  assert v_again.countersigned_at is not null, 'an admin signs';
  assert v_again.countersigned_by = admin, 'and the signature names them';
  raise notice 'PASS only an admin countersigns, and the signature is attributed';

  -- ---- and the signature is not re-datable ---------------------------------
  perform pg_sleep(0.05);
  v_acc := public.countersign_agreement(v_again.id);
  assert v_acc.countersigned_at = v_again.countersigned_at,
    'a second countersign keeps the original moment';
  raise notice 'PASS countersigning twice does not move the date';
end $$;

-- ---- the table itself is closed --------------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a1717171-0000-0000-0000-000000000001', true);
  assert (select count(*) from pg_policies
          where tablename = 'legal_acceptances' and cmd = 'ALL'
            and qual = 'false') = 1,
    'acceptances are writable only through the function';
  raise notice 'PASS an acceptance cannot be written by hand';
end $$;

rollback;
