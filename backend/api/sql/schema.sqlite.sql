-- ENZO — schéma databázy (SQLite)
-- Ceny sú v celých centoch (INTEGER), aby nevznikali zaokrúhľovacie chyby.

CREATE TABLE IF NOT EXISTS settings (
  "key"       TEXT  NOT NULL PRIMARY KEY,
  "value"     TEXT         NULL,
  updated_at  TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT  NOT NULL DEFAULT 'staff',
  is_active     INTEGER   NOT NULL DEFAULT 1,
  last_login_at TEXT     NULL,
  created_at    TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT  NOT NULL UNIQUE,
  label       TEXT  NOT NULL,
  title       TEXT NOT NULL,
  caption     TEXT NULL,
  position    INTEGER          NOT NULL DEFAULT 0,
  is_active   INTEGER   NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT  NOT NULL UNIQUE,
  category_id  INTEGER          NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT         NULL,
  price_cents  INTEGER          NOT NULL,
  image        TEXT NULL,
  image_alt    TEXT NULL,
  badge        TEXT  NULL,
  tags         TEXT NULL,
  lid_accent   TEXT  NULL,
  lid_line1    TEXT  NULL,
  lid_line2    TEXT  NULL,
  vat_group    TEXT  NOT NULL DEFAULT 'food',
  is_available INTEGER   NOT NULL DEFAULT 1,
  position     INTEGER          NOT NULL DEFAULT 0,
  created_at   TEXT     NOT NULL,
  updated_at   TEXT     NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS extras (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT  NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price_cents INTEGER          NOT NULL DEFAULT 0,
  is_active   INTEGER   NOT NULL DEFAULT 1,
  position    INTEGER          NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_extras (
  product_id INTEGER NOT NULL,
  extra_id   INTEGER NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, extra_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pe_extra   FOREIGN KEY (extra_id)   REFERENCES extras(id)   ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number       TEXT  NOT NULL UNIQUE,
  doc_number         TEXT  NULL UNIQUE,
  access_token       TEXT  NOT NULL,
  status             TEXT  NOT NULL DEFAULT 'received',
  order_type         TEXT  NOT NULL,
  payment_method     TEXT  NOT NULL,
  payment_status     TEXT  NOT NULL DEFAULT 'unpaid',
  payment_reference  TEXT NULL,
  paid_at            TEXT     NULL,

  first_name  TEXT  NOT NULL,
  last_name   TEXT  NOT NULL,
  phone       TEXT  NOT NULL,
  email       TEXT NOT NULL,
  street      TEXT NULL,
  house_number TEXT NULL,
  city        TEXT NULL,
  postal_code TEXT  NULL,
  note        TEXT         NULL,
  pickup_time TEXT  NULL,

  subtotal_cents     INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL,
  vat_breakdown      TEXT NULL,

  ready_at        TEXT NULL,
  prep_minutes    INTEGER      NULL,
  confirmed_at    TEXT NULL,
  completed_at    TEXT NULL,
  cancelled_at    TEXT NULL,
  cancel_reason   TEXT NULL,

  customer_ip  TEXT NULL,
  user_agent   TEXT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL,
  product_slug   TEXT  NULL,
  name           TEXT NOT NULL,
  base_cents     INTEGER NOT NULL,
  extras_cents   INTEGER NOT NULL DEFAULT 0,
  unit_cents     INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,
  line_cents     INTEGER NOT NULL,
  extras_json    TEXT NULL,
  note           TEXT NULL,
  vat_group      TEXT NOT NULL DEFAULT 'food',
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL,
  event      TEXT  NOT NULL,
  detail     TEXT NULL,
  user_id    INTEGER NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mail_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  template    TEXT  NOT NULL,
  status      TEXT  NOT NULL,
  error       TEXT         NULL,
  created_at  TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at TEXT    NOT NULL
);

