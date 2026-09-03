-- ENZO — migrácia 002 (SQLite)
-- Dopĺňa históriu stavov, platby ako samostatnú entitu, doručovacie zóny,
-- otváracie hodiny, kupóny, skupiny doplnkov, audit log a idempotenciu.
-- Migrácia je bezpečná aj na už bežiacej inštalácii — nič nemaže.

CREATE TABLE IF NOT EXISTS order_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INT          NOT NULL,
  from_status TEXT  NULL,
  to_status   TEXT  NOT NULL,
  changed_by  INT          NULL,
  actor       TEXT  NOT NULL DEFAULT 'system',
  reason      TEXT NULL,
  created_at  TEXT     NOT NULL,
  CONSTRAINT fk_osh_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INT          NOT NULL,
  provider      TEXT  NOT NULL DEFAULT 'cash',
  method        TEXT  NOT NULL,
  status        TEXT  NOT NULL DEFAULT 'pending',
  amount_cents  INT          NOT NULL,
  currency      TEXT   NOT NULL DEFAULT 'EUR',
  reference     TEXT NULL,
  detail        TEXT         NULL,
  paid_at       TEXT     NULL,
  refunded_cents INT         NOT NULL DEFAULT 0,
  created_at    TEXT     NOT NULL,
  updated_at    TEXT     NOT NULL,
  CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Referencia od providera musí byť unikátna, aby opakovaný webhook
-- nezaúčtoval tú istú platbu druhýkrát.
CREATE TABLE IF NOT EXISTS payment_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id   INT          NULL,
  provider     TEXT  NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT  NOT NULL,
  processed_at TEXT     NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  postal_codes   TEXT NULL,
  fee_cents      INT NOT NULL DEFAULT 0,
  min_order_cents INT NOT NULL DEFAULT 0,
  free_from_cents INT NULL,
  eta_minutes    INT NOT NULL DEFAULT 45,
  is_active      INTEGER NOT NULL DEFAULT 1,
  position       INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS opening_hours (
  weekday    INTEGER NOT NULL PRIMARY KEY,  -- 1 = pondelok … 7 = nedeľa
  is_open    INTEGER  NOT NULL DEFAULT 1,
  open_time  TEXT  NOT NULL DEFAULT '11:00',
  close_time TEXT  NOT NULL DEFAULT '21:00',
  -- posledná objednávka pred zatvorením (minúty)
  last_order_offset INT NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS closures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at  TEXT     NOT NULL,
  ends_at    TEXT     NOT NULL,
  reason     TEXT NULL,
  created_at TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT  NOT NULL UNIQUE,
  description     TEXT NULL,
  kind            TEXT  NOT NULL DEFAULT 'percent', -- percent | fixed | free_delivery
  value           INT          NOT NULL DEFAULT 0,          -- % alebo centy
  min_order_cents INT          NOT NULL DEFAULT 0,
  max_uses        INT          NULL,
  used_count      INT          NOT NULL DEFAULT 0,
  starts_at       TEXT     NULL,
  ends_at         TEXT     NULL,
  is_active       INTEGER   NOT NULL DEFAULT 1,
  created_at      TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS modifier_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT  NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  hint         TEXT NULL,
  is_required  INTEGER NOT NULL DEFAULT 0,
  min_select   INT NOT NULL DEFAULT 0,
  max_select   INT NOT NULL DEFAULT 0,   -- 0 = bez obmedzenia
  position     INT NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_modifier_groups (
  product_id INT NOT NULL,
  group_id   INT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id),
  CONSTRAINT fk_pmg_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pmg_group   FOREIGN KEY (group_id)   REFERENCES modifier_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INT          NULL,
  user_label  TEXT NULL,
  action      TEXT  NOT NULL,
  entity      TEXT  NOT NULL,
  entity_id   TEXT  NULL,
  summary     TEXT NULL,
  ip          TEXT  NULL,
  created_at  TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key     TEXT NOT NULL UNIQUE,
  scope        TEXT  NOT NULL DEFAULT 'order',
  request_hash TEXT  NOT NULL,
  order_id     INT          NULL,
  response     TEXT         NULL,
  created_at   TEXT     NOT NULL
);
