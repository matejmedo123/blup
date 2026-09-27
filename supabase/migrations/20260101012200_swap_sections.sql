-- ============================================================================
-- SWAP: nájdi si miesto, aké chceš
-- ============================================================================
-- Na vypredanom štadióne je pod eventom tridsať ponúk a človek nechce „tú
-- najlacnejšiu" — chce tribúnu, na ktorej sedia jeho ľudia, alebo sektor, z
-- ktorého niečo vidno. Zoradenie podľa ceny mu s tým nepomôže.
--
-- Pribúdajú preto dve veci:
--
--   `p_section` vo výpise ponúk — hľadanie naprieč sektorom, radom, miestom aj
--   popisom vstupenky. Cez `blup_norm`, takže „tribuna juh" nájde „Tribúna
--   Juh" a „sektor a" nájde sektor „A".
--
--   `event_resale_sections` — čo na tom evente naozaj je, s počtami a
--   najnižšou cenou. Appka z toho spraví štítky. Písať do prázdneho poľa
--   „skús sektor" je rada rovnako zlá ako žiadna: človek nevie, či sa sektory
--   volajú A/B/C alebo Sever/Juh, a po treťom prázdnom výsledku to vzdá.
--
-- Zoskupuje sa podľa toho, čo je na ponuke označené: `section`, a keď chýba
-- (státie z inej platformy), tak `ticket_label`. Ponuka bez oboch spadne pod
-- „Bez označenia" a dá sa na ňu kliknúť rovnako.
-- ============================================================================

-- `create or replace` tu nestačí — pribúda parameter, takže by vznikol druhý
-- preťažený variant a volanie s menovanými parametrami by sa stalo
-- nejednoznačným.
drop function if exists public.event_resale_listings(
  uuid, text, integer, integer, resale_source, integer);

create or replace function public.event_resale_listings(
  p_event_id  uuid,
  p_sort      text default 'price_asc',
  p_max_price integer default null,
  p_quantity  integer default null,
  p_source    resale_source default null,
  p_section   text default null,
  p_limit     integer default 50
)
returns table (
  id              uuid,
  seller_id       uuid,
  seller_name     text,
  seller_username text,
  seller_avatar   text,
  source          resale_source,
  authenticity    text,
  section         text,
  row_label       text,
  seat_label      text,
  ticket_label    text,
  quantity        integer,
  price_cents     integer,
  face_value_cents integer,
  currency        text,
  delivery_method resale_delivery_method,
  note            text,
  status          resale_listing_status,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    l.id, l.seller_id, p.display_name, p.username, p.avatar_url,
    l.source,
    -- Jediné miesto, odkiaľ sa smie brať tvrdenie o pravosti. „verified" len
    -- pre naše vstupenky, lebo len tie vieme naozaj overiť.
    case when l.source = 'blup' then 'verified' else 'protected' end,
    l.section, l.row_label, l.seat_label, l.ticket_label,
    l.quantity, l.price_cents, l.face_value_cents, l.currency,
    l.delivery_method, l.note, l.status, l.created_at
  from public.resale_listings l
  join public.profiles p on p.id = l.seller_id
  where l.event_id = p_event_id
    and l.status = 'active'
    and (l.expires_at is null or l.expires_at > now())
    and not p.is_suspended
    and (p_max_price is null or l.price_cents <= p_max_price)
    and (p_quantity is null or l.quantity >= p_quantity)
    and (p_source is null or l.source = p_source)
    -- Hľadanie miesta. Prehľadáva sa všetko, čo o mieste vieme, lebo človek
    -- napíše raz „A", raz „rad 4" a raz „Tribúna Juh" a nemá ako tušiť, do
    -- ktorého políčka to predajca zapísal.
    --
    -- Hľadá sa od ZAČIATKU SLOVA, nie kdekoľvek v texte. Obyčajné `like
    -- '%a%'` vyzeralo správne, kým sa nehľadal sektor „A": vrátilo aj
    -- „Tribúna Juh" aj „VIP lóža", lebo aj tam je písmeno „a". Filter, ktorý
    -- pri jednopísmenovom sektore vráti všetko, je horší než žiadny.
    and (
      nullif(btrim(p_section), '') is null
      or public.blup_norm(
           concat_ws(' ', l.section, l.row_label, l.seat_label, l.ticket_label)
         ) ~ ('(^| )' || regexp_replace(
                public.blup_norm(btrim(p_section)),
                '([.^$|()\[\]{}*+?\\])', '\\\1', 'g'))
    )
    -- Listing s cudzou živou rezerváciou sa neponúka: klik na „Kúpiť" by
    -- skončil chybou a to je horšie než ho nevidieť.
    and not exists (
      select 1 from public.resale_reservations r
      where r.listing_id = l.id
        and r.status = 'active'
        and r.expires_at > now()
        and r.buyer_id is distinct from auth.uid()
    )
  order by
    case when p_sort = 'price_asc'  then l.price_cents end asc,
    case when p_sort = 'price_desc' then l.price_cents end desc,
    case when p_sort = 'newest'     then extract(epoch from l.created_at) end desc,
    l.price_cents asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke execute on function public.event_resale_listings(
  uuid, text, integer, integer, resale_source, text, integer) from public;
grant execute on function public.event_resale_listings(
  uuid, text, integer, integer, resale_source, text, integer) to anon, authenticated;

-- --- čo na evente naozaj je --------------------------------------------------

create or replace function public.event_resale_sections(p_event_id uuid)
returns table (
  label         text,
  listing_count integer,
  ticket_count  integer,
  from_cents    integer,
  currency      text,
  verified_count integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    coalesce(
      nullif(btrim(l.section), ''),
      nullif(btrim(l.ticket_label), ''),
      'Bez označenia'
    ) as label,
    count(*)::integer,
    sum(l.quantity)::integer,
    min(l.price_cents)::integer,
    min(l.currency),
    count(*) filter (where l.source = 'blup')::integer
  from public.resale_listings l
  join public.profiles p on p.id = l.seller_id
  where l.event_id = p_event_id
    and l.status = 'active'
    and (l.expires_at is null or l.expires_at > now())
    and not p.is_suspended
  group by label
  -- Najprv tam, kde je najviac na výber; pri zhode lacnejšie. Abecedne by
  -- sektor s jedinou ponukou vyšiel pred tribúnou s desiatimi.
  order by count(*) desc, min(l.price_cents) asc, label asc;
$$;

revoke execute on function public.event_resale_sections(uuid) from public;
grant execute on function public.event_resale_sections(uuid) to anon, authenticated;
