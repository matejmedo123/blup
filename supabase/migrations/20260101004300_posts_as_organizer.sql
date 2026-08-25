-- ---------------------------------------------------------------------------
-- An organizer can post as their organization.
--
-- Posting existed, but only ever as a person. An organizer who runs a club
-- night had no way to say "doors at nine, last tickets" in the feed under the
-- name the event is sold under — and a post signed with somebody's personal
-- profile is not the same announcement.
--
-- The author is still the person: somebody is accountable for every post, and
-- moderation and deletion keep working off author_id exactly as before. The
-- organization is who it is *published as*, and only a member with a role that
-- can already act for the organization may pick it.
-- ---------------------------------------------------------------------------

alter table public.posts
  add column if not exists organization_id uuid references public.organizations (id) on delete set null;

create index if not exists posts_organization_idx
  on public.posts (organization_id, created_at desc);

comment on column public.posts.organization_id is
  'Published as this organization. NULL = published as the author personally.';

-- Insert: still your own post, and the organization must be one you may speak
-- for. Without the second half anyone could sign a post with any club's name.
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts
  for insert with check (
    author_id = auth.uid()
    and (
      organization_id is null
      or public.is_org_member(
           organization_id,
           array['owner', 'admin', 'event_manager']::org_role[]
         )
    )
  );

-- Update: the same rule, so an existing post cannot be re-signed afterwards.
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts
  for update using (author_id = auth.uid() or public.is_admin())
  with check (
    (author_id = auth.uid() or public.is_admin())
    and (
      organization_id is null
      or public.is_admin()
      or public.is_org_member(
           organization_id,
           array['owner', 'admin', 'event_manager']::org_role[]
         )
    )
  );
