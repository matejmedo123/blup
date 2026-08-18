-- ============================================================================
-- BLUP · 0008 · Behavioural signals + AI recommendation storage
-- ============================================================================

-- Every meaningful interaction with an event becomes a signal. These feed the
-- ranking function in 0009 and can later train an external model.

-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
create table if not exists public.user_event_signals (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  signal     signal_type not null,
  weight     numeric(4,2) not null default 1.0,
  context    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_event_signals_user_idx
  on public.user_event_signals (user_id, created_at desc);
create index if not exists user_event_signals_event_idx
  on public.user_event_signals (event_id, signal);

-- One row per recommendation request, so the "why was this recommended?"
-- debug screen (spec §39) shows real stored scores rather than a re-computation.
create table if not exists public.ai_recommendation_runs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  context    text not null default 'for_you',
  params     jsonb not null default '{}'::jsonb,
  engine     text not null default 'sql_ranker_v1',
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists ai_runs_user_idx on public.ai_recommendation_runs (user_id, created_at desc);

create table if not exists public.ai_recommendation_items (
  run_id     uuid not null references public.ai_recommendation_runs (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  rank       integer not null,
  score      numeric(6,4) not null,
  breakdown  jsonb not null default '{}'::jsonb,
  primary key (run_id, event_id)
);

-- Calls to the external LLM provider (abstraction layer in supabase/functions/_shared/ai.ts)
create table if not exists public.ai_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles (id) on delete set null,
  kind       text not null,
  provider   text,
  model      text,
  prompt     text,
  response   text,
  tokens_in  integer,
  tokens_out integer,
  latency_ms integer,
  error      text,
  created_at timestamptz not null default now()
);

create index if not exists ai_requests_user_idx on public.ai_requests (user_id, created_at desc);

-- Signal recording helper (also used by the mobile client through RPC).
create or replace function public.record_signal(
  p_event_id uuid,
  p_signal   signal_type,
  p_weight   numeric default 1.0,
  p_context  jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.user_event_signals (user_id, event_id, signal, weight, context)
  values (auth.uid(), p_event_id, p_signal, coalesce(p_weight, 1.0), coalesce(p_context, '{}'::jsonb));

  if p_signal in ('open_detail', 'impression') then
    insert into public.event_views (event_id, user_id, source)
    values (p_event_id, auth.uid(), coalesce(p_context ->> 'source', 'app'));

    update public.events
    set view_count = view_count + 1
    where id = p_event_id;
  end if;
end;
$$;
