-- ---------------------------------------------------------------------------
-- Futbalový štadión sa dá načítať.
--
-- Predloha štadióna má 67 sektorov a jej použitie trvalo 77 sekúnd — čiže
-- neprešlo vôbec: appke vyprší požiadavka dávno predtým a človek vidí len to,
-- že sa nič nestalo.
--
-- Kde ten čas bol. Obrys tribúny má 32 bodov, čiže reťaz po 15 úsekov.
-- `edge_point()` prejde reťaz DVAKRÁT (raz aby zrátal jej dĺžku, raz aby našiel
-- bod) a pri každom kroku číta štyri hodnoty z jsonb a pretypúva ich na
-- numeric. `band_point()` volá `edge_point()` dvakrát. A `band_row_length()`
-- volá `band_point()` 65-krát, aby zmerala jeden rad.
--
--   65 × 2 × 2 × 15 × 4  ≈ 15 600 čítaní jsonb na JEDEN rad
--   × 14 radov + 188 miest ≈ 264 000 na jeden sektor
--   × 67 sektorov         ≈ 17 miliónov
--
-- Tvar sa pritom celý ten čas nemení. Stačí ho rozparsovať raz.
--
-- Matematika je tá istá — rovnaké vzorce, rovnaké poradie operácií, rovnaké
-- zaokrúhľovanie — len si body obrysu a dĺžky úsekov oboch reťazí pripraví do
-- polí na začiatku. Prechod reťaze je napísaný priamo v tele, nie ako volanie
-- funkcie: odovzdať pole do funkcie znamená skopírovať ho, čo by v slučke cez
-- tisíc vzoriek vrátilo presne ten problém, ktorý sa tu odstraňuje.
--
-- `check:seats` a SQL testy merajú výsledok, nie rýchlosť. Ak sa čo i len
-- jedno miesto pohne, padnú.
-- ---------------------------------------------------------------------------
create or replace function public.section_seat_grid(
  p_section_id uuid,
  p_rows       integer,
  p_per_row    integer,
  p_start_row  integer default 0,
  p_row_style  text    default 'letters',
  p_row_prefix text    default null,
  p_seat_start integer default 1
)
returns table (row_label text, seat_number integer, slot integer)
language plpgsql
stable
set search_path = public, extensions
as $fn$
declare
  v_shape jsonb;
  v_holes jsonb;
  v_poly  polygon;
  n       integer;
  half    integer;
  shaped  boolean;

  xs numeric[];          -- body obrysu, 1-based
  ys numeric[];
  ca integer[];          -- indexy bodov reťaze A v poradí kráčania
  cb integer[];          -- to isté pre reťaz B (ide naspäť)
  sa numeric[];          -- dĺžky úsekov reťaze A
  sb numeric[];
  ta numeric := 0;       -- celková dĺžka reťaze A
  tb numeric := 0;
  ma integer;            -- počet úsekov reťaze A
  mb integer;

  lens numeric[];        -- dĺžka každého radu
  i integer; k integer; r integer; s integer;
  first integer := greatest(coalesce(p_seat_start, 1), 1);

  want numeric; run numeric; f numeric;
  ax numeric; ay numeric; bx numeric; by_ numeric;
  u numeric; v numeric;
  cx numeric; cy numeric; prev_x numeric; prev_y numeric;
  v_len numeric; v_step numeric; v_per integer;
  spot point;
begin
  select sec.shape, sec.holes, public.jsonb_to_polygon(sec.shape)
    into v_shape, v_holes, v_poly
  from public.venue_sections sec
  where sec.id = p_section_id;

  n := jsonb_array_length(v_shape);
  shaped := v_shape is not null and n is not null and n >= 3;

  if shaped then
    for i in 0 .. n - 1 loop
      xs[i + 1] := (v_shape -> i ->> 'x')::numeric;
      ys[i + 1] := (v_shape -> i ->> 'y')::numeric;
    end loop;

    half := public.band_split(v_shape);

    -- Reťaz A: body 0 → half-1. Reťaz B: n-1 → half, čiže po druhej strane
    -- a naspäť, aby oba konce zodpovedali tomu istému koncu radu.
    ca := array(select generate_series(1, half));
    if n - half >= 1 then
      cb := array(select generate_series(n, half + 1, -1));
    else
      cb := ca;
    end if;

    ma := array_length(ca, 1) - 1;
    mb := array_length(cb, 1) - 1;

    for k in 1 .. greatest(ma, 0) loop
      sa[k] := sqrt((xs[ca[k + 1]] - xs[ca[k]]) ^ 2 + (ys[ca[k + 1]] - ys[ca[k]]) ^ 2);
      ta := ta + sa[k];
    end loop;
    for k in 1 .. greatest(mb, 0) loop
      sb[k] := sqrt((xs[cb[k + 1]] - xs[cb[k]]) ^ 2 + (ys[cb[k + 1]] - ys[cb[k]]) ^ 2);
      tb := tb + sb[k];
    end loop;

    -- --- dĺžka každého radu: 64 vzoriek pozdĺž neho --------------------------
    for r in 0 .. p_rows - 1 loop
      v := (r + 0.5)::numeric / p_rows;
      v_len := 0;

      for s in 0 .. 64 loop
        u := s::numeric / 64;

        -- bod na reťazi A vo vzdialenosti u
        if ma < 1 or ta <= 0 then
          ax := xs[ca[1]]; ay := ys[ca[1]];
        else
          want := least(1, greatest(0, u)) * ta; run := 0;
          for k in 1 .. ma loop
            if run + sa[k] >= want or k = ma then
              f := case when sa[k] <= 0 then 0 else least(1, (want - run) / sa[k]) end;
              ax := xs[ca[k]] + (xs[ca[k + 1]] - xs[ca[k]]) * f;
              ay := ys[ca[k]] + (ys[ca[k + 1]] - ys[ca[k]]) * f;
              exit;
            end if;
            run := run + sa[k];
          end loop;
        end if;

        -- a na reťazi B
        if mb < 1 or tb <= 0 then
          bx := xs[cb[1]]; by_ := ys[cb[1]];
        else
          want := least(1, greatest(0, u)) * tb; run := 0;
          for k in 1 .. mb loop
            if run + sb[k] >= want or k = mb then
              f := case when sb[k] <= 0 then 0 else least(1, (want - run) / sb[k]) end;
              bx := xs[cb[k]] + (xs[cb[k + 1]] - xs[cb[k]]) * f;
              by_ := ys[cb[k]] + (ys[cb[k + 1]] - ys[cb[k]]) * f;
              exit;
            end if;
            run := run + sb[k];
          end loop;
        end if;

        cx := ax + (bx - ax) * v;
        cy := ay + (by_ - ay) * v;

        if s > 0 then
          v_len := v_len + sqrt((cx - prev_x) ^ 2 + (cy - prev_y) ^ 2);
        end if;
        prev_x := cx; prev_y := cy;
      end loop;

      lens[r + 1] := v_len;
    end loop;

    -- Rozostup udáva rad A: toľko miest, koľko si organizátor vypýtal.
    v_step := case when p_per_row > 0 then lens[1] / p_per_row end;
  end if;

  -- --- miesta ---------------------------------------------------------------
  for r in 0 .. p_rows - 1 loop
    v_len := case when shaped then lens[r + 1] end;
    v := (r + 0.5)::numeric / p_rows;

    v_per := case
      when v_len is null or v_step is null or v_step <= 0 then p_per_row
      -- Rad užší než jedno sedadlo nedostane žiadne.
      when v_len < v_step then 0
      -- Miesto potrebuje celý rozostup, nie polovicu: inak posledné sedadlo
      -- vyjde stredom na okraj sektora, čiže polovicou von.
      when p_per_row % 2 = 0 then
        least(p_per_row * 4, 2 * floor(v_len / (2 * v_step) + 0.000000001)::integer)
      else
        least(p_per_row * 4, 2 * floor((v_len / v_step - 1) / 2 + 0.000000001)::integer + 1)
    end;

    for i in first .. first + v_per - 1 loop
      -- slot = 2·(poradie − (počet+1)/2), čiže celé číslo, susedia o dva.
      k := 2 * (i - first + 1) - v_per - 1;

      if not shaped or v_len is null or v_len <= 0 or v_step is null then
        spot := null;
      else
        u := 0.5 + (k::numeric / 2) * v_step / v_len;

        if ma < 1 or ta <= 0 then
          ax := xs[ca[1]]; ay := ys[ca[1]];
        else
          want := least(1, greatest(0, u)) * ta; run := 0;
          for s in 1 .. ma loop
            if run + sa[s] >= want or s = ma then
              f := case when sa[s] <= 0 then 0 else least(1, (want - run) / sa[s]) end;
              ax := xs[ca[s]] + (xs[ca[s + 1]] - xs[ca[s]]) * f;
              ay := ys[ca[s]] + (ys[ca[s + 1]] - ys[ca[s]]) * f;
              exit;
            end if;
            run := run + sa[s];
          end loop;
        end if;

        if mb < 1 or tb <= 0 then
          bx := xs[cb[1]]; by_ := ys[cb[1]];
        else
          want := least(1, greatest(0, u)) * tb; run := 0;
          for s in 1 .. mb loop
            if run + sb[s] >= want or s = mb then
              f := case when sb[s] <= 0 then 0 else least(1, (want - run) / sb[s]) end;
              bx := xs[cb[s]] + (xs[cb[s + 1]] - xs[cb[s]]) * f;
              by_ := ys[cb[s]] + (ys[cb[s + 1]] - ys[cb[s]]) * f;
              exit;
            end if;
            run := run + sb[s];
          end loop;
        end if;

        spot := point((ax + (bx - ax) * v)::float8, (ay + (by_ - ay) * v)::float8);
      end if;

      -- Diera sektor nekreslí, len z neho uberá: mriežka je rovnaká, len
      -- miesta, ktoré padli do schodiska, nevzniknú.
      if (v_poly is null or spot is null or v_poly @> spot)
         and not public.in_any_hole(v_holes, spot) then
        row_label   := public.seat_row_name(p_start_row + r,
                                            coalesce(p_row_style, 'letters'), p_row_prefix);
        seat_number := i;
        slot        := k;
        return next;
      end if;
    end loop;
  end loop;
end;
$fn$;
