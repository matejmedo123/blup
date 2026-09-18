-- ============================================================================
-- Index audit — beží po testoch, nie je to test jednej funkcie
-- ============================================================================
-- Čo hľadá: cudzí kľúč bez indexu. Kým je tabuľka malá, nevidno to. Pri náraze
-- ľudí to je presne ten prípad, keď jedno zmazanie eventu prelezie celú tabuľku
-- vstupeniek, drží zámok a ostatné požiadavky sa začnú hromadiť — čiže „stránka
-- spadla".
--
-- Postgres index pre cudzí kľúč nevyrába sám. Za index sa počíta aj taký, kde
-- je stĺpec PRVÝ zo skupiny — (event_id, user_id) pokrýva aj samotné event_id.
-- ============================================================================
\set ON_ERROR_STOP on

do $$
declare
  r       record;
  missing text[] := '{}';
begin
  for r in
    select
      c.conrelid::regclass::text as tbl,
      a.attname                  as col
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f'
      and n.nspname = 'public'
      -- Zložené cudzie kľúče sa posudzujú podľa prvého stĺpca, tak ako ich
      -- Postgres aj používa.
      and k.ord = 1
      and not exists (
        select 1
        from pg_index i
        where i.indrelid = c.conrelid
          and i.indkey[0] = a.attnum
      )
  loop
    missing := missing || (r.tbl || '.' || r.col);
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception E'Cudzie kľúče bez indexu (%):\n  %',
      array_length(missing, 1), array_to_string(missing, E'\n  ');
  end if;

  raise notice 'PASS každý cudzí kľúč má index — mazanie rodiča neprelezie dieťa';
end $$;
