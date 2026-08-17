#!/usr/bin/env node
/**
 * BLUP demo seed — OPT-IN ONLY.
 *
 * This is deliberately NOT a migration and NOT supabase/seed.sql: a fresh BLUP
 * database must come up in a genuine zero state ("Nothing happening here yet →
 * Create the first BLUP"). Demo data only exists when you explicitly ask for it.
 *
 *   node supabase/seed/seed.mjs             # create demo users, orgs, events
 *   node supabase/seed/seed.mjs --clean     # remove everything this script made
 *   node supabase/seed/seed.mjs --city=vienna --events=40
 *
 * Requires (in .env at the repo root, or the environment):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Every seeded account uses the @blup.demo domain, which is how --clean finds
 * them again. Never point this at a production project.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DEMO_DOMAIN = 'blup.demo';
const DEMO_PASSWORD = 'BlupDemo123!';

// --- tiny .env loader (no dependency needed for a script this small) --------
function loadEnv() {
  for (const file of ['.env', '.env.local']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}
loadEnv();

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(`
✖ Missing credentials.

  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (repo-root .env).
  Find them in your Supabase dashboard → Project Settings → API.
  The service-role key bypasses RLS: keep it out of the mobile app and out of git.
`);
  process.exit(1);
}

if (/\.supabase\.co/.test(SUPABASE_URL) && !args.force && process.env.BLUP_ALLOW_REMOTE_SEED !== 'true') {
  console.warn(`
⚠  ${SUPABASE_URL} looks like a hosted project.
   Re-run with --force (or BLUP_ALLOW_REMOTE_SEED=true) if you really want demo
   data there. Never do this on production.
`);
  if (!args.force) process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- demo world --------------------------------------------------------------
const CITIES = {
  bratislava: { name: 'Bratislava', country: 'SK', lat: 48.1486, lon: 17.1077 },
  vienna: { name: 'Vienna', country: 'AT', lat: 48.2082, lon: 16.3738 },
  prague: { name: 'Prague', country: 'CZ', lat: 50.0755, lon: 14.4378 },
  berlin: { name: 'Berlin', country: 'DE', lat: 52.52, lon: 13.405 },
};

const PEOPLE = [
  ['alex', 'Alex Kováč', 'Techno, climbing and long coffees.', ['techno', 'climbing', 'coffee']],
  ['martin', 'Martin Novák', 'Running the city, one bridge at a time.', ['running', 'craft-beer', 'tech']],
  ['sara', 'Sara Lipták', 'Design by day, dancefloor by night.', ['design', 'house', 'dance']],
  ['tomas', 'Tomáš Bezák', 'Board games and bad puns.', ['board-games', 'gaming', 'books']],
  ['nina', 'Nina Horváth', 'Yoga teacher. Sunrise person.', ['yoga', 'wellness', 'meditation']],
  ['jakub', 'Jakub Varga', 'Startup builder, coffee dependent.', ['startups', 'tech', 'networking']],
  ['ela', 'Ela Sokolová', 'Film nerd with a 35mm habit.', ['cinema', 'photography', 'art']],
  ['peto', 'Peťo Hric', 'Climbing walls and mountain trails.', ['climbing', 'hiking', 'camping']],
  ['lucia', 'Lucia Bartošová', 'Wine, words and weekend markets.', ['wine', 'books', 'food']],
  ['david', 'Dávid Uhrin', 'Bass player. Always in a basement.', ['rock', 'indie', 'nightlife']],
  ['zuzka', 'Zuzka Malá', 'Volunteer coordinator, dog person.', ['volunteering', 'hiking', 'coffee']],
  ['filip', 'Filip Danko', 'Basketball and burgers.', ['basketball', 'food', 'gaming']],
  ['klara', 'Klára Vrbová', 'Museum hopper.', ['museum', 'art', 'theatre']],
  ['adam', 'Adam Rybár', 'Surf trips and swim mornings.', ['surfing', 'swimming', 'wellness']],
  ['veronika', 'Veronika Kissová', 'Jazz, always.', ['jazz', 'wine', 'cinema']],
  ['samo', 'Samo Bielik', 'Cyclist. Two wheels, no excuses.', ['cycling', 'running', 'craft-beer']],
  ['hana', 'Hana Prokopová', 'Language exchange host.', ['language', 'coffee', 'books']],
  ['matej', 'Matej Šimko', 'Investing meetups and skiing.', ['investing', 'skiing', 'networking']],
  ['dominika', 'Dominika Rusnák', 'Karaoke champion (self-declared).', ['karaoke', 'bars', 'hiphop']],
  ['oliver', 'Oliver Marek', 'Cooking for far too many people.', ['cooking', 'food', 'festival']],
];

const ORGANIZATIONS = [
  {
    slug: 'nova-collective',
    name: 'Nova Collective',
    description: 'Warehouse parties and techno nights since 2019.',
    verified: true,
    fee: 300,
  },
  {
    slug: 'city-runners',
    name: 'City Runners Club',
    description: 'Weekly runs, races and recovery brunches.',
    verified: true,
    fee: 250,
  },
  {
    slug: 'garage-talks',
    name: 'Garage Talks',
    description: 'Founder talks in unusual venues. Verification pending.',
    verified: false,
    fee: 300,
  },
];

const EVENT_TEMPLATES = [
  ['Warehouse night: {n}', 'techno', ['techno', 'nightlife'], 'Nova Warehouse', true],
  ['Sunrise yoga in the park', 'yoga', ['yoga', 'wellness'], 'City Park', false],
  ['5k riverside run', 'running', ['running', 'outdoor'], 'Riverside path', false],
  ['Boulder session for beginners', 'climbing', ['climbing'], 'Vertical Gym', false],
  ['Indie night: three bands', 'indie', ['indie', 'rock'], 'Club Underground', true],
  ['Founder breakfast', 'startups', ['startups', 'networking'], 'Impact Hub', false],
  ['Natural wine tasting', 'wine', ['wine', 'food'], 'Cellar 47', true],
  ['Board game marathon', 'board-games', ['board-games', 'gaming'], 'Meeple Café', false],
  ['Open air cinema: cult classics', 'cinema', ['cinema', 'art'], 'Rooftop', false],
  ['Street food market', 'food', ['food', 'coffee'], 'Old Market Hall', false],
  ['Photo walk at golden hour', 'photography', ['photography', 'art'], 'Old town', false],
  ['Language exchange evening', 'language', ['language', 'social'], 'Café Lingua', false],
  ['Basketball pickup game', 'basketball', ['basketball', 'sport'], 'Court 9', false],
  ['Jazz in the courtyard', 'jazz', ['jazz', 'wine'], 'Inner courtyard', true],
  ['Volunteer clean-up morning', 'volunteering', ['volunteering', 'outdoor'], 'Riverbank', false],
  ['Karaoke championship', 'karaoke', ['karaoke', 'nightlife'], 'Bar Voce', false],
  ['Cycling tour: 40 km loop', 'cycling', ['cycling', 'outdoor'], 'North gate', false],
  ['Design critique night', 'design', ['design', 'tech'], 'Studio 12', false],
  ['Investing 101 meetup', 'investing', ['investing', 'networking'], 'Finance Tower', true],
  ['Hiking day trip', 'hiking', ['hiking', 'camping'], 'Trailhead', false],
];

// --- helpers -----------------------------------------------------------------
const random = (list) => list[Math.floor(Math.random() * list.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Random point within `radiusKm` of the city centre. */
function scatter(center, radiusKm = 6) {
  const radiusDeg = radiusKm / 111;
  const angle = Math.random() * 2 * Math.PI;
  const distance = Math.sqrt(Math.random()) * radiusDeg;
  return {
    latitude: Number((center.lat + distance * Math.cos(angle)).toFixed(6)),
    longitude: Number(
      (center.lon + (distance * Math.sin(angle)) / Math.cos((center.lat * Math.PI) / 180)).toFixed(6),
    ),
  };
}

function futureDate(maxDays = 30) {
  const date = new Date();
  date.setDate(date.getDate() + randomInt(0, maxDays));
  date.setHours(randomInt(8, 22), random([0, 15, 30]), 0, 0);
  return date;
}

async function clean() {
  console.log('→ Removing demo data…');

  const { data: users } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const demoUsers = (users?.users ?? []).filter((u) => u.email?.endsWith(`@${DEMO_DOMAIN}`));

  // Organizations are not owned by cascade from auth.users (created_by is
  // RESTRICT), so remove them first.
  await db.from('organizations').delete().in('slug', ORGANIZATIONS.map((o) => o.slug));

  for (const user of demoUsers) {
    await db.auth.admin.deleteUser(user.id);
  }

  console.log(`✓ Removed ${demoUsers.length} demo accounts and their content.`);
}

async function seed() {
  const cityKey = String(args.city ?? 'bratislava').toLowerCase();
  const city = CITIES[cityKey] ?? CITIES.bratislava;
  const eventCount = Math.min(Math.max(Number(args.events ?? 32), 5), 60);

  console.log(`→ Seeding ${PEOPLE.length} people and ${eventCount} events around ${city.name}…`);

  // 1. interests must exist (they ship as a migration, not as seed data)
  const { data: interests, error: interestError } = await db.from('interests').select('id, slug');
  if (interestError) throw interestError;
  if (!interests?.length) {
    throw new Error('No interests found — run the migrations first (npm run db:push).');
  }
  const interestBySlug = new Map(interests.map((i) => [i.slug, i.id]));

  // 2. users
  const profiles = [];
  for (const [username, displayName, bio, tags] of PEOPLE) {
    const email = `${username}@${DEMO_DOMAIN}`;

    const { data: created, error } = await db.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { username, display_name: displayName },
    });

    if (error) {
      if (!error.message.includes('already been registered')) throw error;
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list?.users.find((u) => u.email === email);
      if (!existing) throw error;
      profiles.push({ id: existing.id, username, tags });
      continue;
    }

    const position = scatter(city, 4);
    await db
      .from('profiles')
      .update({
        display_name: displayName,
        bio,
        city: city.name,
        country: city.country,
        onboarding_completed: true,
        location_updated_at: new Date().toISOString(),
        ...position,
      })
      .eq('id', created.user.id);

    await db.from('user_interests').insert(
      tags
        .filter((tag) => interestBySlug.has(tag))
        .map((tag) => ({ user_id: created.user.id, interest_id: interestBySlug.get(tag) })),
    );

    profiles.push({ id: created.user.id, username, tags });
  }
  console.log(`✓ ${profiles.length} demo accounts (password: ${DEMO_PASSWORD})`);

  // 3. organizations
  const organizations = [];
  for (const [index, org] of ORGANIZATIONS.entries()) {
    const owner = profiles[index % profiles.length];

    const { data: created, error } = await db
      .from('organizations')
      .insert({
        slug: org.slug,
        name: org.name,
        description: org.description,
        created_by: owner.id,
        country: city.country,
        city: city.name,
        contact_email: `hello@${org.slug}.demo`,
        verification_status: org.verified ? 'verified' : 'pending',
        payouts_enabled: org.verified,
        charges_enabled: org.verified,
        platform_fee_bps: org.fee,
      })
      .select()
      .single();

    if (error) throw error;
    organizations.push({ ...created, ownerId: owner.id });

    if (!org.verified) {
      await db.from('organization_verification_requests').insert({
        organization_id: created.id,
        submitted_by: owner.id,
        legal_name: `${org.name} s.r.o.`,
        registration_number: `SK${randomInt(10000000, 99999999)}`,
        contact_email: `hello@${org.slug}.demo`,
        status: 'pending',
      });
    }
  }
  console.log(`✓ ${organizations.length} organizations (${organizations.filter((o) => o.verification_status === 'verified').length} verified)`);

  // 4. events
  const verifiedOrgs = organizations.filter((o) => o.verification_status === 'verified');
  const events = [];

  for (let i = 0; i < eventCount; i++) {
    const [titleTemplate, category, tags, venue, paid] = EVENT_TEMPLATES[i % EVENT_TEMPLATES.length];
    const isPaid = paid && verifiedOrgs.length > 0;
    const org = isPaid ? random(verifiedOrgs) : null;
    const creator = org ? { id: org.ownerId } : random(profiles);
    const start = futureDate(30);
    const end = new Date(start.getTime() + randomInt(2, 6) * 3600 * 1000);
    const position = scatter(city, 7);

    const { data: created, error } = await db
      .from('events')
      .insert({
        creator_id: creator.id,
        organization_id: org?.id ?? null,
        title: titleTemplate.replace('{n}', String(i + 1)),
        description:
          'Demo event created by the BLUP seed script. Everything here is real data in your database — RSVP, save it, comment on it, or delete it.',
        category,
        tags,
        venue_name: venue,
        address: `${venue}, ${city.name}`,
        city: city.name,
        country: city.country,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        capacity: Math.random() > 0.4 ? randomInt(20, 200) : null,
        is_free: !isPaid,
        price_cents: isPaid ? randomInt(5, 45) * 100 : 0,
        currency: 'EUR',
        status: 'published',
        visibility: 'public',
        ...position,
      })
      .select()
      .single();

    if (error) throw error;
    events.push(created);

    if (isPaid) {
      await db.from('ticket_types').insert([
        {
          event_id: created.id,
          name: 'Early bird',
          price_cents: Math.round(created.price_cents * 0.8),
          currency: 'EUR',
          quantity_total: randomInt(20, 60),
          max_per_order: 4,
          sales_end_at: new Date(start.getTime() - 48 * 3600 * 1000).toISOString(),
        },
        {
          event_id: created.id,
          name: 'Standard',
          price_cents: created.price_cents,
          currency: 'EUR',
          quantity_total: randomInt(50, 200),
          max_per_order: 6,
        },
      ]);
    }
  }
  console.log(`✓ ${events.length} events (${events.filter((e) => !e.is_free).length} ticketed)`);

  // 5. social graph
  const follows = [];
  for (const person of profiles) {
    const others = profiles.filter((p) => p.id !== person.id);
    for (let i = 0; i < randomInt(3, 8); i++) {
      const target = random(others);
      follows.push({ follower_id: person.id, following_id: target.id });
    }
  }
  await db.from('follows').upsert(follows, { onConflict: 'follower_id,following_id' });

  const attendees = [];
  for (const event of events) {
    for (let i = 0; i < randomInt(0, 9); i++) {
      attendees.push({
        event_id: event.id,
        user_id: random(profiles).id,
        status: random(['going', 'going', 'going', 'interested']),
      });
    }
  }
  await db.from('event_attendees').upsert(attendees, { onConflict: 'event_id,user_id' });

  const saves = [];
  const signals = [];
  for (const person of profiles) {
    for (let i = 0; i < randomInt(2, 6); i++) {
      const event = random(events);
      saves.push({ user_id: person.id, event_id: event.id });
      signals.push({ user_id: person.id, event_id: event.id, signal: 'save', weight: 1 });
      signals.push({ user_id: person.id, event_id: event.id, signal: 'open_detail', weight: 1 });
    }
  }
  await db.from('saved_events').upsert(saves, { onConflict: 'user_id,event_id' });
  await db.from('user_event_signals').insert(signals);

  // 6. communities + a few comments so the social layer is not empty
  const { data: community } = await db
    .from('communities')
    .insert({
      slug: `${cityKey}-nightlife`,
      name: `${city.name} Nightlife`,
      description: 'Where to go after dark.',
      category: 'nightlife',
      city: city.name,
      created_by: profiles[0].id,
    })
    .select()
    .single();

  if (community) {
    await db.from('community_members').upsert(
      profiles.slice(0, 10).map((p) => ({ community_id: community.id, user_id: p.id })),
      { onConflict: 'community_id,user_id' },
    );
  }

  await db.from('comments').insert(
    events.slice(0, 8).map((event) => ({
      event_id: event.id,
      user_id: random(profiles).id,
      body: random([
        'Is anyone driving from the centre?',
        'Been to the last one, highly recommend.',
        'What time do doors open?',
        'Bringing three friends 🙌',
      ]),
    })),
  );

  console.log(`
✓ Seed complete.

  Sign in with any of:  ${PEOPLE.slice(0, 3).map(([u]) => `${u}@${DEMO_DOMAIN}`).join(', ')}
  Password:             ${DEMO_PASSWORD}

  To make yourself an admin, run in the SQL editor:
    update public.profiles set app_role = 'admin' where email = 'you@example.com';

  Remove all of this again with:  npm run seed:clean
`);
}

try {
  if (args.clean) {
    await clean();
  } else {
    await seed();
  }
} catch (error) {
  console.error('\n✖ Seed failed:', error.message ?? error);
  process.exit(1);
}
