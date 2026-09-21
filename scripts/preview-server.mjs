#!/usr/bin/env node
/**
 * Lokálny backend na POZERANIE obrazoviek — nie na testovanie logiky.
 *
 *   ./scripts/preview.sh            # postaví databázu, spustí server aj web
 *
 * Prečo existuje: celú appku sa dá odoviesť bez toho, aby ju človek niekedy
 * videl s dátami. Väčšina chýb v tomto projekte bola presne taká — „ODPOVEDAŤ"
 * v každej bubline, text lámaný po písmenách, jeden počet ľudí pod dvoma
 * sektormi, koliesko myši, ktoré nič nerobilo. Všetky by boli vidieť na prvý
 * pohľad, keby bolo kam sa pozrieť.
 *
 * Čo to JE: tenká vrstva nad SKUTOČNOU databázou — migrácie sa aplikujú tak,
 * ako sú, funkcie sa volajú tak, ako sú. Odpovede teda pochádzajú z rovnakého
 * SQL, aké beží naostro.
 *
 * Čo to NIE JE: náhrada Supabase. Nerieši RLS ani overovanie tokenov — beží ako
 * jeden zvolený používateľ, ktorý sa zadá cez BLUP_PREVIEW_USER. Preto sa tým
 * NEDÁ testovať bezpečnosť; na to je probe-security.sh proti skutočnému
 * projektu. Tu ide o to, ako obrazovka vyzerá.
 */

/**
 * A JSON argument as something Postgres will take.
 *
 * Everything used to go through String(v) and a pair of quotes. That is right
 * for a uuid and wrong for everything else: an array of seat ids arrived as
 * one comma-joined string, so `delete_seats` and `set_seat_state` did nothing
 * and said nothing, and an outline arrived as "[object Object]". Both look
 * like app bugs from the browser and are not.
 *
 * An array of plain values becomes an array literal left untyped, so Postgres
 * reads it as whatever the parameter is — uuid[], text[], int[]. Anything with
 * shape in it becomes jsonb, which is what such a parameter always is here.
 */
function literal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const quoted = (text) => `'${String(text).replace(/'/g, "''")}'`;
  if (Array.isArray(v)) {
    const plain = v.every((one) => one === null
      || typeof one === 'string' || typeof one === 'number' || typeof one === 'boolean');
    if (!plain) return `${quoted(JSON.stringify(v))}::jsonb`;
    const parts = v.map((one) => (one === null ? 'NULL'
      : `"${String(one).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`));
    return quoted(`{${parts.join(',')}}`);
  }
  if (typeof v === 'object') return `${quoted(JSON.stringify(v))}::jsonb`;
  return quoted(v);
}

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.BLUP_PREVIEW_PORT ?? 4310);
const SOCKET = process.env.BLUP_PG_SOCKET ?? '/tmp/blup-preview/socket';
// Some sandboxes sweep unix socket files out from under a running postgres,
// and psql then reports the server as simply not there. BLUP_PG_PORT switches
// the whole thing to TCP, which nothing cleans up.
const PG_PORT = process.env.BLUP_PG_PORT ? ['-p', process.env.BLUP_PG_PORT] : [];
const DB = process.env.BLUP_PREVIEW_DB ?? 'blup_preview';
const PG_USER = process.env.BLUP_PG_USER ?? 'postgres';

/** Runs SQL and returns rows as JSON, through psql so no driver is needed. */
function sql(query, asUser) {
  // `\o /dev/null` around the prelude so psql prints ONE value: the JSON.
  // Taking "the last line" instead was wrong the moment any text column held a
  // newline — the JSON then spans lines and the tail of it is not valid JSON.
  const prelude = asUser
    ? `\\o /dev/null\nselect set_config('request.jwt.claim.sub', '${asUser}', false);\n\\o\n`
    : '';
  const wrapped =
    `${prelude}select coalesce(json_agg(t), '[]'::json)::text from (${query}) t;`;

  // Through a file rather than -c. The query contains quotes of both kinds and
  // wrapping it for `su ... -c` mangles them; a file has no quoting at all.
  const file = join(dirname(SOCKET), 'query.sql');
  writeFileSync(file, wrapped, { mode: 0o644 });

  const args = ['-h', SOCKET, '-U', 'postgres', '-d', DB, '-At', '-f', file];
  const run = () => (process.getuid?.() === 0
    ? execFileSync('su', [PG_USER, '-s', '/bin/bash', '-c',
      `psql -h ${SOCKET} ${PG_PORT.join(" ")} -U postgres -d ${DB} -At -f ${file}`], { encoding: 'utf8' })
    : execFileSync('psql', args, { encoding: 'utf8' }));

  return JSON.parse(run().trim() || '[]');
}

/**
 * Ktoré stĺpce ktorá tabuľka má — načítané raz, na začiatku.
 *
 * Musí sa to rozhodnúť v JS, nie v SQL. `case when exists(...)` síce beží až
 * za behu, ale Postgres obe vetvy PARSUJE — a vetva, ktorá sa pýta na
 * neexistujúci stĺpec, zhodí celý dotaz ešte pred vykonaním.
 */
let COLUMNS = new Map();

function loadSchema() {
  const rows = sql(
    `select table_name, column_name from information_schema.columns `
    + `where table_schema = 'public'`,
  );
  COLUMNS = new Map();
  for (const row of rows) {
    if (!COLUMNS.has(row.table_name)) COLUMNS.set(row.table_name, new Set());
    COLUMNS.get(row.table_name).add(row.column_name);
  }
}

const hasColumn = (table, column) => COLUMNS.get(table)?.has(column) ?? false;

/** The account every request runs as. */
const asUser = () => process.env.BLUP_PREVIEW_USER ?? null;

const json = (res, body, code = 200) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(body));
};

/** PostgREST's `col=eq.value` / `col=in.(a,b)` filters, as a WHERE clause. */
function whereFrom(params) {
  const parts = [];
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    const quoted = `'${value.replace(/'/g, "''")}'`;
    if (op === 'eq') parts.push(`"${key}" = ${quoted}`);
    else if (op === 'neq') parts.push(`"${key}" <> ${quoted}`);
    else if (op === 'is') parts.push(`"${key}" is ${value}`);
    else if (op === 'gt') parts.push(`"${key}" > ${quoted}`);
    else if (op === 'lt') parts.push(`"${key}" < ${quoted}`);
    else if (op === 'gte') parts.push(`"${key}" >= ${quoted}`);
    else if (op === 'lte') parts.push(`"${key}" <= ${quoted}`);
    else if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',')
        .map((v) => `'${v.replace(/^"|"$/g, '').replace(/'/g, "''")}'`).join(',');
      parts.push(`"${key}" in (${list || 'null'})`);
    }
  }
  return parts.length ? `where ${parts.join(' and ')}` : '';
}

/**
 * Rozbalí `select=` do SQL, vrátane vnorených tabuliek.
 *
 * PostgREST vie vnoriť cez cudzí kľúč; tu sa to hádá podľa mena — dieťa má
 * stĺpec `<rodič v jednotnom čísle>_id`. Na tento projekt to stačí a je to
 * lepšie než embed ticho zahodiť: obrazovka by potom vyzerala pokazene z
 * dôvodu, ktorý je v náhľade, nie v appke. („Event nemá typy vstupeniek" na
 * evente, ktorý ich má tri.)
 */
function selectFrom(table, select) {
  if (!select || select.trim() === '*') return 't.*';

  const parent = table.replace(/ies$/, 'y').replace(/s$/, '');
  const pieces = [];

  // `alias:table!hint (cols)` alebo `table (cols)`
  const embeds = [...select.matchAll(/(?:(\w+)\s*:\s*)?(\w+)(?:!([\w]+))?\s*\(([^()]*)\)/g)];

  const columns = select
    .replace(/(?:(\w+)\s*:\s*)?(\w+)(?:![\w]+)?\s*\([^()]*\)/g, '')
    .split(',').map((c) => c.trim()).filter(Boolean)
    .filter((c) => !c.includes(':') && !c.endsWith('!'));

  pieces.push(columns.length === 0 || columns.includes('*')
    ? 't.*'
    : columns.map((c) => `t."${c}"`).join(', '));

  for (const [, alias, child, hint, inner] of embeds) {
    const name = alias ?? child;
    const fk = `${parent}_id`;
    // `profiles!events_creator_id_fkey` — the hint names the constraint, and
    // the column is what is left after the parent table and `_fkey`. Without
    // reading it the guess is `profile_id`, which events does not have, and
    // the whole query fails rather than just that one embed.
    const hinted = hint ? new RegExp(`^${table}_(.+)_fkey$`).exec(hint)?.[1] : null;

    if (inner.trim() === 'count') {
      pieces.push(`(select json_agg(json_build_object('count', n)) from `
        + `(select count(*) as n from public."${child}" c where c."${fk}" = t.id) s) as "${name}"`);
      continue;
    }

    // Rodič (events.organization_id -> organizations) alebo dieťa
    // (ticket_types.event_id -> events). Rozhodne sa podľa toho, ktorý stĺpec
    // naozaj existuje.
    const childCols = inner.split(',').map((c) => c.trim()).filter(Boolean);
    const list = childCols.includes('*') ? 'c.*' : childCols.map((c) => `c."${c}"`).join(', ');
    const parentFk = hinted ?? `${child.replace(/ies$/, 'y').replace(/s$/, '')}_id`;

    if (!hinted && hasColumn(child, fk)) {
      // Dieťa: ticket_types.event_id -> events.id
      pieces.push(`(select json_agg(x) from (select ${list} from public."${child}" c `
        + `where c."${fk}" = t.id) x) as "${name}"`);
    } else {
      // Rodič: events.organization_id -> organizations.id
      pieces.push(`(select to_json(x) from (select ${list} from public."${child}" c `
        + `where c.id = t."${parentFk}") x) as "${name}"`);
    }
  }

  return pieces.join(', ');
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, {});

  const url = new URL(req.url, 'http://localhost');
  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });

  try {
    // --- auth: one fixed signed-in account ---------------------------------
    if (url.pathname.startsWith('/auth/v1/')) {
      const id = asUser();
      if (!id) return json(res, { user: null, session: null }, 401);
      const [user] = sql(
        `select u.id, u.email, 'authenticated' as role from auth.users u where u.id = '${id}'`,
      );
      if (url.pathname.endsWith('/logout')) return json(res, {});
      const session = {
        access_token: 'preview', token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'preview', user,
      };
      return json(res, url.pathname.endsWith('/user') ? user : session);
    }

    // --- rpc ----------------------------------------------------------------
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop();
      const args = Object.entries(body)
        .map(([k, v]) => `${k} => ${literal(v)}`)
        .join(', ');
      const rows = sql(`select public.${fn}(${args}) as value`, asUser());
      const value = rows[0]?.value;
      return json(res, value ?? null);
    }

    // --- tables -------------------------------------------------------------
    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
      const params = [...url.searchParams.entries()];
      const order = url.searchParams.get('order');
      const limit = url.searchParams.get('limit');

      const query = `select ${selectFrom(table, url.searchParams.get('select'))} `
        + `from public."${table}" t ${whereFrom(params)} `
        + `${order ? `order by "${order.split('.')[0]}" ${order.includes('desc') ? 'desc' : 'asc'}` : ''} `
        + `${limit ? `limit ${Number(limit)}` : ''}`;

      const rows = sql(query, asUser());

      // `.single()` / `.maybeSingle()` ask for ONE object, not an array — via
      // the Accept header, the way PostgREST does it. Returning an array to
      // those callers makes every field read as undefined, which looks exactly
      // like a row that is not there.
      const wantsOne = String(req.headers.accept ?? '').includes('pgrst.object');
      if (wantsOne) {
        if (rows.length === 0) {
          return json(res, { message: 'no rows', code: 'PGRST116' }, 406);
        }
        return json(res, rows[0]);
      }
      return json(res, rows);
    }

    return json(res, { error: 'not a preview route' }, 404);
  } catch (error) {
    console.error(String(error).slice(0, 400));
    return json(res, { message: String(error).slice(0, 300) }, 500);
  }
}).listen(PORT, () => {
  loadSchema();
  console.log(`preview backend on http://localhost:${PORT} (db ${DB}, user ${asUser() ?? 'anon'})`);
});
