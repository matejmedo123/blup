-- ============================================================================
-- BLUP test 21 · Posting as an organization
-- ============================================================================
-- What is actually being proved here:
--
--   · a member who may act for an organization can publish under its name
--   · somebody outside it cannot sign a post with that organization
--   · a member with no standing to speak for it (a scanner) cannot either
--   · a published post cannot be re-signed with an organization afterwards
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a2121212-0000-0000-0000-000000000001', 'owner21@example.com',   '{"display_name":"Owner"}'),
  ('a2121212-0000-0000-0000-000000000002', 'outsider21@example.com','{"display_name":"Outsider"}'),
  ('a2121212-0000-0000-0000-000000000003', 'finance21@example.com', '{"display_name":"Finance"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('c2121212-0000-0000-0000-000000000001', 'Nova Collective', 'nova-21',
        'a2121212-0000-0000-0000-000000000001', 'verified');

-- The creator is made owner by trigger; the scanner is added explicitly.
insert into public.organization_members (organization_id, user_id, role)
values ('c2121212-0000-0000-0000-000000000001', 'a2121212-0000-0000-0000-000000000003', 'finance')
on conflict do nothing;

set local role authenticated;

-- --- the owner may publish under the organization ----------------------------
do $$
declare v_id uuid;
begin
  perform set_config('request.jwt.claim.sub', 'a2121212-0000-0000-0000-000000000001', true);

  insert into public.posts (author_id, organization_id, body)
  values ('a2121212-0000-0000-0000-000000000001', 'c2121212-0000-0000-0000-000000000001',
          'Dvere o deviatej, posledné lístky na mieste.')
  returning id into v_id;

  assert v_id is not null, 'the owner can publish as the organization';
  raise notice 'PASS an organizer can post under their organization';
end $$;

-- --- an outsider may not ------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a2121212-0000-0000-0000-000000000002', true);
  begin
    insert into public.posts (author_id, organization_id, body)
    values ('a2121212-0000-0000-0000-000000000002', 'c2121212-0000-0000-0000-000000000001',
            'Zrušené, nechoďte.');
    raise exception 'TEST FAILED: an outsider signed a post with somebody else''s organization';
  exception
    when insufficient_privilege then
      raise notice 'PASS an outsider cannot post as an organization they are not in';
    when raise_exception then raise;
  end;
end $$;

-- --- nor a member without standing to speak for it ---------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a2121212-0000-0000-0000-000000000003', true);
  begin
    insert into public.posts (author_id, organization_id, body)
    values ('a2121212-0000-0000-0000-000000000003', 'c2121212-0000-0000-0000-000000000001',
            'Ahojte od účtovníka.');
    raise exception 'TEST FAILED: a finance member published in the organization''s name';
  exception
    when insufficient_privilege then
      raise notice 'PASS a member without standing cannot post in its name';
    when raise_exception then raise;
  end;
end $$;

-- --- and a personal post cannot be re-signed later ----------------------------
do $$
declare v_id uuid;
begin
  perform set_config('request.jwt.claim.sub', 'a2121212-0000-0000-0000-000000000002', true);

  insert into public.posts (author_id, body)
  values ('a2121212-0000-0000-0000-000000000002', 'Bol som tam, bolo super.')
  returning id into v_id;

  begin
    update public.posts
       set organization_id = 'c2121212-0000-0000-0000-000000000001'
     where id = v_id;
    raise exception 'TEST FAILED: a post was re-signed with an organization';
  exception
    when insufficient_privilege then
      raise notice 'PASS a post cannot be re-signed with an organization afterwards';
    when raise_exception then raise;
  end;
end $$;

rollback;
