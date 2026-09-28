-- ============================================================================
-- SWAP — nájdi si miesto, aké chceš
-- ============================================================================
-- Na vypredanom štadióne je pod eventom tridsať ponúk a človek nehľadá „tú
-- najlacnejšiu", ale tribúnu. Testuje sa to, čo appka o tomto hľadaní tvrdí:
--
--   „štítky ukazujú, čo tu naozaj je"   nie abecedný zoznam všetkých sektorov
--   „nájde to aj bez diakritiky"         „tribuna juh" = „Tribúna Juh"
--   „hľadá vo všetkom, čo o mieste vieme" sektor, rad, miesto aj popis
--   „filter nezruší ostatné filtre"      spolu so zoradením a s „len overené"
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a6262626-0000-0000-0000-000000000001', 'org62@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a6262626-0000-0000-0000-000000000002', 'sell62@example.com', now(), '{"display_name":"Predajca"}'),
  ('a6262626-0000-0000-0000-000000000003', 'sel62b@example.com', now(), '{"display_name":"Druhý predajca"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b6262626-0000-0000-0000-000000000001', 'Štadión s.r.o.', 'stadion-62',
        'a6262626-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b6262626-0000-0000-0000-000000000001', 'a6262626-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, is_free, price_cents, currency, status, visibility
) values (
  'e6262626-0000-0000-0000-000000000001',
  'a6262626-0000-0000-0000-000000000001', 'b6262626-0000-0000-0000-000000000001',
  'Vypredané derby', 'football', 48.30, 18.08,
  now() + interval '14 days', now() + interval '14 days 2 hours',
  false, 2000, 'EUR', 'published', 'public'
);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total)
values ('f6262626-0000-0000-0000-000000000001', 'e6262626-0000-0000-0000-000000000001',
        'Sedenie', 2000, 'EUR', 500);

-- Dve naše vstupenky do sektora A, zvyšok sú ponuky odinakiaľ.
insert into public.tickets (id, event_id, ticket_type_id, buyer_id, code, qr_secret, price_cents, currency) values
  ('c6262626-0000-0000-0000-000000000001', 'e6262626-0000-0000-0000-000000000001',
   'f6262626-0000-0000-0000-000000000001', 'a6262626-0000-0000-0000-000000000002',
   'BLP-62-1', 'secret-62-1', 2000, 'EUR'),
  ('c6262626-0000-0000-0000-000000000002', 'e6262626-0000-0000-0000-000000000001',
   'f6262626-0000-0000-0000-000000000001', 'a6262626-0000-0000-0000-000000000003',
   'BLP-62-2', 'secret-62-2', 2000, 'EUR');

do $$
declare
  v_ev uuid := 'e6262626-0000-0000-0000-000000000001';
begin
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', 'a6262626-0000-0000-0000-000000000002', true);
  perform public.create_resale_listing(v_ev, 'blup', 2500,
    'c6262626-0000-0000-0000-000000000001'::uuid,
    p_section => 'A', p_row_label => '4', p_seat_label => '12');
  perform public.create_resale_listing(v_ev, 'external', 1800, null,
    p_delivery_method => 'file', p_ticket_label => 'Tribúna Juh',
    p_ticket_file_path => 'sellers/a6262626-0000-0000-0000-000000000002/juh1.pdf');
  perform public.create_resale_listing(v_ev, 'external', 2200, null,
    p_delivery_method => 'file', p_ticket_label => 'Tribúna Juh',
    p_ticket_file_path => 'sellers/a6262626-0000-0000-0000-000000000002/juh2.pdf');

  perform set_config('request.jwt.claim.sub', 'a6262626-0000-0000-0000-000000000003', true);
  perform public.create_resale_listing(v_ev, 'blup', 3000,
    'c6262626-0000-0000-0000-000000000002'::uuid,
    p_section => 'A', p_row_label => '11', p_seat_label => '3');
  perform public.create_resale_listing(v_ev, 'external', 4500, null,
    p_delivery_method => 'file', p_ticket_label => 'VIP lóža',
    p_ticket_file_path => 'sellers/a6262626-0000-0000-0000-000000000003/vip.pdf');
  -- Ponuka bez akéhokoľvek označenia miesta.
  perform public.create_resale_listing(v_ev, 'external', 1600, null,
    p_delivery_method => 'file',
    p_ticket_file_path => 'sellers/a6262626-0000-0000-0000-000000000003/bez.pdf');

  reset role;
end $$;

-- ============================================================================
-- 1. Štítky ukazujú, čo tu naozaj je — a v poradí, ktoré pomáha
-- ============================================================================
do $$
declare
  v_ev uuid := 'e6262626-0000-0000-0000-000000000001';
  v_labels text[];
  v_first  record;
  v_n      integer;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  select array_agg(label order by ord) into v_labels
  from (select label, row_number() over () as ord
        from public.event_resale_sections(v_ev)) s;

  assert v_labels @> array['A', 'Tribúna Juh', 'VIP lóža', 'Bez označenia'],
    format('chýba niektorý štítok: %s', v_labels);
  assert array_length(v_labels, 1) = 4,
    format('čakali sa štyri štítky, je %s (%s)', array_length(v_labels, 1), v_labels);

  -- Najviac na výber ide hore. Abecedne by „A" vyhralo len náhodou, a pri
  -- sektore s jedinou ponukou by to bolo zavádzajúce.
  assert v_labels[1] in ('A', 'Tribúna Juh'),
    format('hore má byť to, kde je najviac na výber, je %s', v_labels[1]);

  select * into v_first from public.event_resale_sections(v_ev) where label = 'Tribúna Juh';
  assert v_first.listing_count = 2, 'Tribúna Juh má dve ponuky';
  assert v_first.from_cents = 1800, 'najnižšia cena na Tribúne Juh je 18 €';
  assert v_first.verified_count = 0, 'na Tribúne Juh nie je žiadna overená';

  select * into v_first from public.event_resale_sections(v_ev) where label = 'A';
  assert v_first.verified_count = 2, 'v sektore A sú dve overené';

  -- Sektor, ktorý tu nie je, sa medzi štítkami neobjaví — štítok, po ktorom
  -- je prázdno, je horší než žiadny.
  select count(*) into v_n from public.event_resale_sections(v_ev) where label = 'Sektor Z';
  assert v_n = 0, 'objavil sa štítok bez jedinej ponuky';

  reset role;
  raise notice 'PASS 1/3 — štítky ukazujú, čo na evente naozaj je';
end $$;

-- ============================================================================
-- 2. Hľadá vo všetkom, čo o mieste vieme — a bez diakritiky
-- ============================================================================
do $$
declare
  v_ev uuid := 'e6262626-0000-0000-0000-000000000001';
  v_n  integer;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Bez filtra je tam všetko.
  select count(*) into v_n from public.event_resale_listings(v_ev);
  assert v_n = 6, format('bez filtra má byť šesť ponúk, je %s', v_n);

  -- Diakritika ani veľké písmená hľadanie nezastavia.
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, null, 'tribuna juh');
  assert v_n = 2, format('„tribuna juh" malo nájsť dve, našlo %s', v_n);

  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, null, 'TRIBÚNA JUH');
  assert v_n = 2, format('veľké písmená rozbili hľadanie: %s', v_n);

  -- Sektor. Jedno písmeno je tu tá zradná časť: „a" je aj v „Tribúna Juh" aj
  -- vo „VIP lóža", takže hľadanie kdekoľvek v texte by vrátilo skoro všetko.
  -- Hľadá sa od začiatku slova, takže „A" je naozaj len sektor A.
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, null, 'A');
  assert v_n = 2, format('sektor „A" malo nájsť práve dve, našlo %s', v_n);

  -- Rad. Človek nemá ako tušiť, do ktorého políčka to predajca zapísal,
  -- takže sa hľadá aj tam.
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, null, '11');
  assert v_n = 1, format('podľa radu sa mala nájsť jedna, našlo %s', v_n);

  -- Nezmysel nevráti nič a netvári sa, že vrátil.
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, null, 'sektor ktorý neexistuje');
  assert v_n = 0, format('nezmysel vrátil %s ponúk', v_n);

  -- Prázdny reťazec aj samé medzery znamenajú „nefiltruj".
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, null, '   ');
  assert v_n = 6, format('prázdny filter niečo odfiltroval: %s', v_n);

  reset role;
  raise notice 'PASS 2/3 — nájde miesto podľa sektora, radu aj popisu';
end $$;

-- ============================================================================
-- 3. Filter miesta sa znáša s ostatnými filtrami
-- ============================================================================
-- Toto je tá časť, ktorá sa pri pridávaní filtra pokazí najčastejšie: nový
-- filter zaberie, ale ticho prebije zoradenie alebo starý filter.
do $$
declare
  v_ev    uuid := 'e6262626-0000-0000-0000-000000000001';
  v_first integer;
  v_n     integer;
  v_prices integer[];
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Miesto + len overené.
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, 'blup'::resale_source, 'A');
  assert v_n = 2, format('„sektor A + len overené" má dať dve, dalo %s', v_n);

  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', null, null, 'blup'::resale_source, 'Tribúna Juh');
  assert v_n = 0, 'na Tribúne Juh žiadna overená nie je, a predsa sa nejaká našla';

  -- Miesto + zoradenie. Musí platiť oboje naraz.
  select array_agg(price_cents order by ord) into v_prices
  from (select price_cents, row_number() over () as ord
        from public.event_resale_listings(v_ev, 'price_desc', null, null, null, 'A')) s;
  assert v_prices[1] = 3000 and v_prices[2] = 2500,
    format('zoradenie od najdrahšieho v sektore A nesedí: %s', v_prices);

  -- Miesto + strop ceny.
  select count(*) into v_n from public.event_resale_listings(
    v_ev, 'price_asc', 2000, null, null, 'Tribúna Juh');
  assert v_n = 1, format('„Tribúna Juh do 20 €" má dať jednu, dalo %s', v_n);

  reset role;
  raise notice 'PASS 3/3 — filter miesta sa znáša so zoradením aj ostatnými filtrami';
end $$;

rollback;
