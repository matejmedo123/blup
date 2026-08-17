-- ============================================================================
-- BLUP · 0012 · Storage buckets, storage policies, realtime publication
-- ============================================================================
-- Guarded with to_regclass() so the file also runs on a plain Postgres used for
-- schema verification (where the storage/realtime schemas do not exist).
-- ============================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present – skipping bucket setup';
    return;
  end if;

  -- Public read buckets (avatars, event covers/gallery, org branding)
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('avatars', 'avatars', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
    ('event-images', 'event-images', true, 10485760,
     array['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
    ('org-assets', 'org-assets', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Private bucket for KYC / verification documents
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('verification-docs', 'verification-docs', false, 10485760,
          array['image/jpeg', 'image/png', 'application/pdf'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end
$$;

-- Storage RLS. Object paths are always `<owner-uuid>/<filename>` so ownership
-- can be derived from the first path segment.
do $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;

  execute 'drop policy if exists "blup avatars are readable" on storage.objects';
  execute $p$
    create policy "blup avatars are readable" on storage.objects
      for select using (bucket_id in ('avatars', 'event-images', 'org-assets'))
  $p$;

  execute 'drop policy if exists "blup users manage own avatar" on storage.objects';
  execute $p$
    create policy "blup users manage own avatar" on storage.objects
      for all
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;

  execute 'drop policy if exists "blup users manage own event images" on storage.objects';
  execute $p$
    create policy "blup users manage own event images" on storage.objects
      for all
      using (bucket_id = 'event-images' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'event-images' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;

  execute 'drop policy if exists "blup org members manage org assets" on storage.objects';
  execute $p$
    create policy "blup org members manage org assets" on storage.objects
      for all
      using (
        bucket_id = 'org-assets'
        and public.is_org_member(((storage.foldername(name))[1])::uuid,
                                 array['owner','admin']::org_role[])
      )
      with check (
        bucket_id = 'org-assets'
        and public.is_org_member(((storage.foldername(name))[1])::uuid,
                                 array['owner','admin']::org_role[])
      )
  $p$;

  execute 'drop policy if exists "blup verification docs are private" on storage.objects';
  execute $p$
    create policy "blup verification docs are private" on storage.objects
      for all
      using (
        bucket_id = 'verification-docs'
        and (
          public.is_admin()
          or public.is_org_member(((storage.foldername(name))[1])::uuid,
                                  array['owner','admin']::org_role[])
        )
      )
      with check (
        bucket_id = 'verification-docs'
        and public.is_org_member(((storage.foldername(name))[1])::uuid,
                                 array['owner','admin']::org_role[])
      )
  $p$;
end
$$;

-- ---------------------------------------------------------------------------
-- Realtime: the app subscribes to these tables (map updates, RSVP counts,
-- notifications, live ticket state).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present – skipping';
    return;
  end if;

  foreach t in array array[
    'events', 'event_attendees', 'comments', 'notifications',
    'tickets', 'orders', 'event_likes'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- Realtime needs full row images for UPDATE/DELETE payloads on these tables.
alter table public.events replica identity full;
alter table public.event_attendees replica identity full;
alter table public.notifications replica identity full;
