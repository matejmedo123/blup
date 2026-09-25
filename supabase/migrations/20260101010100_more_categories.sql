-- ---------------------------------------------------------------------------
-- Viac kategórií: kvíz, šport, koncert, stand-up…
--
-- The catalogue was written around the five visual families and never grew past
-- them, so whole kinds of event had nowhere to go. A pub quiz had to be filed
-- under "board games" or "other"; a hockey match under "football". "Other" is
-- the honest answer when nothing fits, and it is a bad answer when the thing
-- that fits simply was not on the list — it takes the event out of every
-- category filter and out of everyone's interests at once.
--
-- Fifteen that were missing. Each one lands in an existing interest group, so
-- the onboarding picker keeps its headings and nothing has to be re-grouped.
-- ---------------------------------------------------------------------------
insert into public.interests (slug, name, category, emoji, sort_order) values
  ('concert',    'Concerts',       'music',     '🎼', 17),
  ('party',      'Parties',        'nightlife', '🎉', 73),

  ('sport',      'Sport',          'sport',     '🏅', 19),
  ('hockey',     'Ice hockey',     'sport',     '🏒', 27),
  ('tennis',     'Tennis',         'sport',     '🎾', 28),
  ('fitness',    'Fitness',        'sport',     '🏋️', 29),

  ('standup',    'Stand-up',       'culture',   '🎙️', 46),
  ('comedy',     'Comedy',         'culture',   '😂', 47),
  ('market',     'Markets',        'culture',   '🧺', 48),

  ('conference', 'Conferences',    'business',  '📊', 65),
  ('workshop',   'Workshops',      'business',  '🛠️', 66),

  ('quiz',       'Quiz nights',    'social',    '❓', 84),
  ('esports',    'Esports',        'social',    '🕹️', 85),
  ('family',     'Family',         'social',    '👨‍👩‍👧', 86),
  ('charity',    'Charity',        'social',    '🎗️', 87)
on conflict (slug) do update
  set name        = excluded.name,
      category    = excluded.category,
      emoji       = excluded.emoji,
      sort_order  = excluded.sort_order;
