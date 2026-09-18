-- ============================================================================
-- Je databáza rovnako stará ako appka?
--
-- Four separate bug reports in a row turned out to be the same thing: the web
-- build was newer than the database it was talking to. Chat died on a missing
-- `messages.reply_to_id`; Blup Connect showed nobody because
-- `community_people_you_may_know` did not exist; the waitlist and the invites
-- were invisible for the same reason. Each looked like a different broken
-- feature, and each was one un-run migration.
--
-- Nothing in the app said so. A missing function comes back from PostgREST as
-- an English sentence about a schema cache, which a screen either swallows or
-- prints raw — so "I pushed the build" and "I pushed the database" were
-- indistinguishable from the outside.
--
-- This is the function that makes them distinguishable. The APP owns the list
-- of what it needs, because the app is the thing that needs it; the database
-- only answers what it has. If this function is itself missing, that is the
-- clearest possible answer to the question.
-- ============================================================================
set search_path = public, extensions;

/**
 * Which of these exist here.
 *
 * Names are matched loosely on purpose — a function is named without its
 * argument types, so a signature change does not read as "missing".
 *
 * Admin only: the shape of a schema is not something to hand out, and the only
 * screen that asks is the admin's own deployment page.
 */
create or replace function public.objects_present(
  p_functions text[] default '{}',
  p_tables    text[] default '{}',
  p_columns   text[] default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  fns  jsonb := '{}'::jsonb;
  tbls jsonb := '{}'::jsonb;
  cols jsonb := '{}'::jsonb;
  name text;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  foreach name in array coalesce(p_functions, '{}') loop
    fns := fns || jsonb_build_object(name, exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = name
    ));
  end loop;

  foreach name in array coalesce(p_tables, '{}') loop
    tbls := tbls || jsonb_build_object(name, to_regclass('public.' || quote_ident(name)) is not null);
  end loop;

  -- "table.column", because a column arriving late is the other half of how a
  -- database ends up older than the app.
  foreach name in array coalesce(p_columns, '{}') loop
    cols := cols || jsonb_build_object(name, exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = split_part(name, '.', 1)
        and c.column_name = split_part(name, '.', 2)
    ));
  end loop;

  return jsonb_build_object(
    'functions', fns,
    'tables', tbls,
    'columns', cols,
    -- Useful on its own: a schema with no migrations at all answers zero.
    'migrations_applied', (
      select count(*) from information_schema.tables
      where table_schema = 'public'
    )
  );
end;
$$;

revoke execute on function public.objects_present(text[], text[], text[]) from public, anon;
grant execute on function public.objects_present(text[], text[], text[]) to authenticated;
