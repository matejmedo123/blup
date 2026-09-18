-- ============================================================================
-- Viac odznakov — a hlavne za viac druhov vecí
--
-- Doteraz ich bolo štrnásť a merali sedem počítadiel v `user_stats`: koľko si
-- spravil eventov, na koľkých si bol, check-iny, uložené, séria, level, XP.
-- Všetko sú to varianty jedného správania. Človek, ktorý chodí na rôzne veci,
-- píše recenzie, ťahá partiu alebo drží komunitu, nemal za to nič.
--
-- Nové metriky sa ZÁMERNE nepočítajú do nových stĺpcov. Ďalšie počítadlo
-- znamená ďalší trigger na každej ceste zápisu, a keď jeden chýba, číslo tichu
-- zamrzne — odznak potom buď nepríde nikdy, alebo príde za niečo, čo sa
-- nestalo. Namiesto toho je tu jedno miesto, `badge_metric_value()`, ktoré sa
-- spýta skutočných riadkov. Je to drahšie, ale beží to pri činnosti, nie v
-- cykle, a odpoveď je vždy pravda.
--
-- Pribúda aj `check_my_badges()`, lebo časť nových metrík (recenzie, sledovanie,
-- komunity) nemá s `user_stats` nič spoločné a sama by vyhodnotenie nespustila.
-- Obrazovka s odznakmi ho zavolá pri otvorení, takže odznak nezostane visieť.
-- ============================================================================
set search_path = public, extensions;

alter table public.badges drop constraint if exists badges_metric_check;
alter table public.badges add constraint badges_metric_check
  check (metric in (
    -- z user_stats
    'events_created', 'events_attended', 'check_ins',
    'blups_saved', 'streak_days', 'level', 'xp',
    -- počítané zo skutočných riadkov
    'reviews_written', 'following', 'followers', 'communities_joined',
    'crews_joined', 'posts_written', 'friends_invited', 'tickets_bought',
    'cities_visited', 'categories_tried'
  ));

-- ---------------------------------------------------------------------------
-- Jedno miesto, ktoré vie, ako sa čo počíta
-- ---------------------------------------------------------------------------
create or replace function public.badge_metric_value(p_user uuid, p_metric text)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(case p_metric
    when 'events_created'  then (select events_created  from public.user_stats where user_id = p_user)
    when 'events_attended' then (select events_attended from public.user_stats where user_id = p_user)
    when 'check_ins'       then (select check_ins        from public.user_stats where user_id = p_user)
    when 'blups_saved'     then (select blups_saved      from public.user_stats where user_id = p_user)
    when 'streak_days'     then (select streak_days      from public.user_stats where user_id = p_user)
    when 'level'           then (select level            from public.user_stats where user_id = p_user)
    when 'xp'              then (select xp               from public.user_stats where user_id = p_user)

    when 'reviews_written' then
      (select count(*)::int from public.event_reviews r
       where r.user_id = p_user and nullif(btrim(coalesce(r.body, '')), '') is not null)

    when 'following' then
      (select count(*)::int from public.follows f where f.follower_id = p_user)

    when 'followers' then
      (select count(*)::int from public.follows f where f.following_id = p_user)

    when 'communities_joined' then
      (select count(*)::int from public.community_members m where m.user_id = p_user)

    when 'crews_joined' then
      (select count(*)::int from public.event_crew_members m where m.user_id = p_user)

    when 'posts_written' then
      (select count(*)::int from public.posts p where p.author_id = p_user)

    -- Len tí, ktorí pozvánku naozaj premenili na účet, ktorý niečo robí —
    -- qualify_invites() to posudzuje, nie samotné odoslanie linku.
    when 'friends_invited' then
      (select count(*)::int from public.invites i
       where i.inviter_id = p_user and i.qualified_at is not null)

    when 'tickets_bought' then
      (select count(*)::int from public.orders o
       where o.buyer_id = p_user and o.payment_status = 'succeeded')

    -- Koľko rôznych miest a koľko rôznych druhov vecí. Toto sú tie dva odznaky,
    -- ktoré sa nedajú vyzbierať tým, že človek chodí stále na to isté.
    when 'cities_visited' then
      (select count(distinct lower(btrim(e.city)))::int
       from public.event_attendees a
       join public.events e on e.id = a.event_id
       where a.user_id = p_user
         and a.status in ('going', 'checked_in')
         and nullif(btrim(coalesce(e.city, '')), '') is not null
         and public.event_has_ended(e.start_at, e.end_at))

    when 'categories_tried' then
      (select count(distinct e.category)::int
       from public.event_attendees a
       join public.events e on e.id = a.event_id
       where a.user_id = p_user
         and a.status in ('going', 'checked_in')
         and e.category is not null
         and public.event_has_ended(e.start_at, e.end_at))

    else 0
  end, 0);
$$;

grant execute on function public.badge_metric_value(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Nové odznaky
-- ---------------------------------------------------------------------------
insert into public.badges (slug, name, description, emoji, metric, threshold, tier, sort_order) values
  ('reviewer-1',     'Povedal si to',      'Prvá recenzia, ktorú si niekomu napísal',   '✍️', 'reviews_written',    1,  1, 70),
  ('reviewer-10',    'Kritik',             'Desať recenzií — organizátori to čítajú',   '📝', 'reviews_written',   10,  2, 71),
  ('reviewer-50',    'Hlas scény',         'Päťdesiat recenzií',                        '🗞️', 'reviews_written',   50,  3, 72),

  ('friendly-5',     'Máš okruh',          'Sleduješ piatich ľudí',                     '👥', 'following',          5,  1, 80),
  ('friendly-25',    'Poznáš sa s nimi',   'Dvadsaťpäť ľudí, ktorých sleduješ',         '🫂', 'following',         25,  2, 81),
  ('followed-10',    'Chodia za tebou',    'Desať ľudí sleduje teba',                   '📡', 'followers',         10,  2, 82),
  ('followed-100',   'Ťaháš ľudí',         'Sto ľudí sleduje teba',                     '🌟', 'followers',        100,  4, 83),

  ('community-1',    'Nie si sám',         'Si v prvej komunite',                       '🏘️', 'communities_joined', 1,  1, 90),
  ('community-5',    'Patríš niekam',      'Päť komunít',                               '🏛️', 'communities_joined', 5,  2, 91),

  ('crew-1',         'Ideme spolu',        'Prvá partia, s ktorou si niekam šiel',      '🚐', 'crews_joined',       1,  1, 95),
  ('crew-10',        'Nikdy nejdeš sám',   'Desať výletov v partii',                    '🎒', 'crews_joined',      10,  3, 96),

  ('poster-1',       'Prvý príspevok',     'Napísal si do feedu',                       '💬', 'posts_written',      1,  1, 100),
  ('poster-25',      'Máš čo povedať',     'Dvadsaťpäť príspevkov',                     '📢', 'posts_written',     25,  2, 101),

  ('inviter-1',      'Priviedol si kamoša','Niekto prišiel na BLUP cez teba',           '🤙', 'friends_invited',    1,  2, 110),
  ('inviter-10',     'Ťaháš celú partiu',  'Desať ľudí prišlo cez tvoju pozvánku',      '🧲', 'friends_invited',   10,  4, 111),

  ('buyer-1',        'Prvá vstupenka',     'Kúpil si si prvú vstupenku',                '🎫', 'tickets_bought',     1,  1, 120),
  ('buyer-10',       'Nešetríš',           'Desať kúpených vstupeniek',                 '💳', 'tickets_bought',    10,  2, 121),

  ('cities-3',       'Cestovateľ',         'Bol si na eventoch v troch mestách',        '🧭', 'cities_visited',     3,  2, 130),
  ('cities-10',      'Doma všade',         'Desať rôznych miest',                       '🗺️', 'cities_visited',    10,  4, 131),

  ('curious-5',      'Zvedavý',            'Päť rôznych kategórií eventov',             '🎲', 'categories_tried',   5,  2, 140),
  ('curious-10',     'Všežravec',          'Desať rôznych kategórií — skúšaš všetko',   '🦄', 'categories_tried',  10,  4, 141)
on conflict (slug) do update
  set name = excluded.name,
      description = excluded.description,
      emoji = excluded.emoji,
      metric = excluded.metric,
      threshold = excluded.threshold,
      tier = excluded.tier,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Vyhodnotenie, teraz cez jedno miesto
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_badges(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_badge public.badges%rowtype;
  v_value integer;
  v_new   integer := 0;
begin
  if p_user is null then
    return 0;
  end if;

  -- Bez `user_stats` sa už nekončí: nové metriky s nimi nemajú nič spoločné a
  -- človek, ktorý napísal recenziu skôr, než mu vznikol riadok so štatistikami,
  -- by o odznak prišiel.
  for v_badge in
    select b.* from public.badges b
    where not exists (
      select 1 from public.user_badges ub
      where ub.user_id = p_user and ub.badge_id = b.id
    )
  loop
    v_value := public.badge_metric_value(p_user, v_badge.metric);

    if v_value >= v_badge.threshold then
      insert into public.user_badges (user_id, badge_id)
      values (p_user, v_badge.id)
      on conflict do nothing;

      if found then
        v_new := v_new + 1;
        perform public.notify_user(
          p_user,
          'badge_earned'::notification_type,
          'Získal si odznak ' || v_badge.emoji,
          v_badge.name || ' — ' || v_badge.description,
          null, null,
          jsonb_build_object('badge_slug', v_badge.slug)
        );
      end if;
    end if;
  end loop;

  return v_new;
end;
$$;

/**
 * Vyhodnotí odznaky pre prihláseného človeka.
 *
 * Existuje preto, že recenzia, sledovanie alebo vstup do komunity nemenia
 * `user_stats`, takže by samy vyhodnotenie nespustili a odznak by prišiel až
 * pri najbližšej nesúvisiacej činnosti. Obrazovka s odznakmi to zavolá pri
 * otvorení. Nič nemôže udeliť odznak, ktorý si človek nezaslúžil — prahy
 * kontroluje tá istá funkcia ako vždy.
 */
create or replace function public.check_my_badges()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  return public.evaluate_badges(auth.uid());
end;
$$;

revoke execute on function public.check_my_badges() from public, anon;
grant execute on function public.check_my_badges() to authenticated;

-- ---------------------------------------------------------------------------
-- A postup, aby bolo vidieť, ako ďaleko je človek k ďalšiemu
-- ---------------------------------------------------------------------------
create or replace function public.my_badges()
returns table (
  slug        text,
  name        text,
  description text,
  emoji       text,
  tier        integer,
  threshold   integer,
  metric      text,
  progress    integer,
  earned      boolean,
  awarded_at  timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    b.slug, b.name, b.description, b.emoji, b.tier, b.threshold, b.metric,
    least(public.badge_metric_value(auth.uid(), b.metric), b.threshold),
    ub.user_id is not null,
    ub.awarded_at
  from public.badges b
  left join public.user_badges ub on ub.badge_id = b.id and ub.user_id = auth.uid()
  order by b.sort_order;
$$;

grant execute on function public.my_badges() to authenticated;
