-- ---------------------------------------------------------------------------
-- A view is an opened event, not a card that scrolled past.
--
-- record_signal counted a view for `impression` as well as `open_detail`, so
-- scrolling the feed inflated the view count of every event that appeared in
-- it. An organizer reading "412 zobrazení" was reading how far people scrolled.
--
-- Impressions are still recorded as signals — the ranker uses them, and it
-- should: an event shown and ignored is real information. They simply stop
-- being counted as views.
-- ---------------------------------------------------------------------------

create or replace function public.record_signal(
  p_event_id uuid,
  p_signal   signal_type,
  p_weight   numeric default 1.0,
  p_context  jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.user_event_signals (user_id, event_id, signal, weight, context)
  values (auth.uid(), p_event_id, p_signal, coalesce(p_weight, 1.0), coalesce(p_context, '{}'::jsonb));

  -- Only opening the event's own page counts as a view.
  if p_signal = 'open_detail' then
    perform public.record_event_view(p_event_id, coalesce(p_context ->> 'source', 'app'));
  end if;
end;
$$;

-- `create or replace` keeps the existing privileges, so the grants made when
-- this function was first defined still stand.
