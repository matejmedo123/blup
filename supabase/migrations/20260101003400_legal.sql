-- ============================================================================
-- Legal documents, and proof of who agreed to which version.
--
-- Terms change. An acceptance that only records "agreed" is worthless the
-- moment they do, because nobody can say what was agreed to — so a document is
-- versioned, its text is immutable once published, and an acceptance points at
-- one exact version.
--
-- The organizer agreement is countersigned: the organizer accepts it by
-- submitting verification, and BLUP signs when an admin approves. Both halves
-- are recorded, because a contract with one signature is not a contract.
-- ============================================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'legal_document_kind') then
    create type legal_document_kind as enum ('terms', 'privacy', 'organizer_agreement');
  end if;
end $$;

create table if not exists public.legal_documents (
  id           uuid primary key default gen_random_uuid(),
  kind         legal_document_kind not null,
  version      text not null,
  locale       text not null default 'sk',
  title        text not null,
  body         text not null,
  -- Null while it is being written; set when it becomes the live version.
  published_at timestamptz,
  created_at   timestamptz not null default now(),

  unique (kind, version, locale),
  constraint legal_documents_body_len check (char_length(body) between 100 and 200000)
);

create index if not exists legal_documents_live_idx
  on public.legal_documents (kind, locale, published_at desc);

-- Published text is evidence. It may be superseded by a new version, never
-- edited in place — otherwise "you agreed to this" means nothing.
create or replace function public.freeze_published_legal()
returns trigger
language plpgsql
as $$
begin
  if old.published_at is not null
     and (new.body <> old.body or new.title <> old.title or new.version <> old.version) then
    raise exception 'LEGAL_DOCUMENT_PUBLISHED';
  end if;
  return new;
end;
$$;

drop trigger if exists legal_documents_freeze on public.legal_documents;
create trigger legal_documents_freeze
  before update on public.legal_documents
  for each row execute function public.freeze_published_legal();

-- ---------------------------------------------------------------------------
-- Acceptances
-- ---------------------------------------------------------------------------
create table if not exists public.legal_acceptances (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.legal_documents (id) on delete restrict,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  -- Set when the agreement is made on behalf of an organization.
  organization_id uuid references public.organizations (id) on delete cascade,
  accepted_at     timestamptz not null default now(),
  -- BLUP's half of a countersigned agreement.
  countersigned_at timestamptz,
  countersigned_by uuid references public.profiles (id) on delete set null,

  unique (document_id, user_id, organization_id)
);

create index if not exists legal_acceptances_user_idx
  on public.legal_acceptances (user_id, accepted_at desc);
create index if not exists legal_acceptances_org_idx
  on public.legal_acceptances (organization_id) where organization_id is not null;

alter table public.legal_documents  enable row level security;
alter table public.legal_acceptances enable row level security;

-- Anyone may read a published document; that is the point of publishing it.
drop policy if exists legal_documents_select on public.legal_documents;
create policy legal_documents_select on public.legal_documents
  for select using (published_at is not null or public.is_admin());

drop policy if exists legal_documents_write on public.legal_documents;
create policy legal_documents_write on public.legal_documents
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists legal_acceptances_select on public.legal_acceptances;
create policy legal_acceptances_select on public.legal_acceptances
  for select using (
    user_id = auth.uid()
    or public.is_admin()
    or (organization_id is not null and public.is_org_member(organization_id, null, auth.uid()))
  );

-- Written only through accept_legal_document(), so a row cannot be back-dated
-- or pointed at a document the person never saw.
drop policy if exists legal_acceptances_write on public.legal_acceptances;
create policy legal_acceptances_write on public.legal_acceptances
  for all using (false) with check (false);

-- ---------------------------------------------------------------------------
-- The live version of a document
-- ---------------------------------------------------------------------------
create or replace function public.current_legal_document(
  p_kind   legal_document_kind,
  p_locale text default 'sk'
)
returns public.legal_documents
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select *
  from public.legal_documents
  where kind = p_kind
    and published_at is not null
    and locale in (p_locale, 'sk')
  order by (locale = p_locale) desc, published_at desc
  limit 1;
$$;

grant execute on function public.current_legal_document(legal_document_kind, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Accepting
-- ---------------------------------------------------------------------------
create or replace function public.accept_legal_document(
  p_document_id     uuid,
  p_organization_id uuid default null
)
returns public.legal_acceptances
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_doc  public.legal_documents;
  v_row  public.legal_acceptances;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_doc from public.legal_documents where id = p_document_id;
  if not found or v_doc.published_at is null then
    raise exception 'DOCUMENT_NOT_PUBLISHED';
  end if;

  if p_organization_id is not null
     and not public.is_org_member(p_organization_id, null, v_user) then
    raise exception 'NOT_AN_ORGANIZER';
  end if;

  insert into public.legal_acceptances (document_id, user_id, organization_id)
  values (p_document_id, v_user, p_organization_id)
  on conflict (document_id, user_id, organization_id) do update
    set accepted_at = public.legal_acceptances.accepted_at   -- keep the first one
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.accept_legal_document(uuid, uuid) from public;
grant execute on function public.accept_legal_document(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- BLUP's half
-- ---------------------------------------------------------------------------
create or replace function public.countersign_agreement(p_acceptance_id uuid)
returns public.legal_acceptances
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.legal_acceptances;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.legal_acceptances
  set countersigned_at = coalesce(countersigned_at, now()),
      countersigned_by = coalesce(countersigned_by, auth.uid())
  where id = p_acceptance_id
  returning * into v_row;

  if not found then
    raise exception 'ACCEPTANCE_NOT_FOUND';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.countersign_agreement(uuid) from public;
grant execute on function public.countersign_agreement(uuid) to authenticated;
