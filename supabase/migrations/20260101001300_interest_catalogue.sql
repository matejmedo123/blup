-- ============================================================================
-- BLUP · 0013 · Interest catalogue (reference data, NOT demo seed)
-- ============================================================================
-- This is production reference data: the app cannot run onboarding without it.
-- Demo users/events live exclusively in supabase/seed/ and are never inserted
-- by a migration, so a fresh database starts in a genuine zero state.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;
insert into public.interests (slug, name, category, emoji, sort_order) values
  ('techno',        'Techno',            'music',     '🔊', 10),
  ('house',         'House',             'music',     '🏠', 11),
  ('hiphop',        'Hip-hop',           'music',     '🎤', 12),
  ('rock',          'Rock',              'music',     '🎸', 13),
  ('jazz',          'Jazz',              'music',     '🎷', 14),
  ('indie',         'Indie',             'music',     '🎧', 15),
  ('festival',      'Festivals',         'music',     '🎪', 16),
  ('running',       'Running',           'sport',     '🏃', 20),
  ('cycling',       'Cycling',           'sport',     '🚴', 21),
  ('climbing',      'Climbing',          'sport',     '🧗', 22),
  ('football',      'Football',          'sport',     '⚽', 23),
  ('basketball',    'Basketball',        'sport',     '🏀', 24),
  ('yoga',          'Yoga',              'sport',     '🧘', 25),
  ('swimming',      'Swimming',          'sport',     '🏊', 26),
  ('hiking',        'Hiking',            'outdoor',   '🥾', 30),
  ('camping',       'Camping',           'outdoor',   '⛺', 31),
  ('skiing',        'Skiing',            'outdoor',   '🎿', 32),
  ('surfing',       'Surfing',           'outdoor',   '🏄', 33),
  ('art',           'Art',               'culture',   '🎨', 40),
  ('theatre',       'Theatre',           'culture',   '🎭', 41),
  ('cinema',        'Cinema',            'culture',   '🎬', 42),
  ('museum',        'Museums',           'culture',   '🏛️', 43),
  ('photography',   'Photography',       'culture',   '📷', 44),
  ('books',         'Books',             'culture',   '📚', 45),
  ('food',          'Food',              'food',      '🍜', 50),
  ('coffee',        'Coffee',            'food',      '☕', 51),
  ('wine',          'Wine',              'food',      '🍷', 52),
  ('craft-beer',    'Craft beer',        'food',      '🍺', 53),
  ('cooking',       'Cooking',           'food',      '👨‍🍳', 54),
  ('startups',      'Startups',          'business',  '🚀', 60),
  ('tech',          'Tech',              'business',  '💻', 61),
  ('design',        'Design',            'business',  '✏️', 62),
  ('networking',    'Networking',        'business',  '🤝', 63),
  ('investing',     'Investing',         'business',  '📈', 64),
  ('nightlife',     'Nightlife',         'nightlife', '🌃', 70),
  ('bars',          'Bars',              'nightlife', '🍸', 71),
  ('karaoke',       'Karaoke',           'nightlife', '🎙️', 72),
  ('board-games',   'Board games',       'social',    '🎲', 80),
  ('gaming',        'Gaming',            'social',    '🎮', 81),
  ('language',      'Language exchange', 'social',    '🗣️', 82),
  ('volunteering',  'Volunteering',      'social',    '💚', 83),
  ('wellness',      'Wellness',          'wellness',  '🌿', 90),
  ('meditation',    'Meditation',        'wellness',  '🕯️', 91),
  ('dance',         'Dance',             'wellness',  '💃', 92),
  ('other',         'Something else',    'other',     '✨', 999)
on conflict (slug) do update
  set name = excluded.name,
      category = excluded.category,
      emoji = excluded.emoji,
      sort_order = excluded.sort_order;
