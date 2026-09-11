-- Majáles Nitra — schéma pre MySQL / MariaDB (Websupport)
-- Všetko, čo je na webe vidieť, sa dá zmeniť v admine. Preto je v databáze
-- aj obsah, ktorý by inak bol natvrdo v šablóne.

CREATE TABLE IF NOT EXISTS migrations (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(190) NOT NULL,
  applied_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_migrations_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  skey        VARCHAR(100) NOT NULL,
  svalue      TEXT NULL,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (skey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(64) NOT NULL,
  display_name   VARCHAR(120) NOT NULL DEFAULT '',
  password_hash  VARCHAR(255) NOT NULL,
  role           VARCHAR(20) NOT NULL DEFAULT 'editor',
  active         TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at  DATETIME NULL,
  created_at     DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nahrané obrázky. Web zobrazuje `path`, admin `thumb_path`.
CREATE TABLE IF NOT EXISTS media (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  path           VARCHAR(255) NOT NULL,
  thumb_path     VARCHAR(255) NULL,
  original_name  VARCHAR(255) NOT NULL DEFAULT '',
  mime           VARCHAR(80) NOT NULL DEFAULT '',
  width          INT UNSIGNED NOT NULL DEFAULT 0,
  height         INT UNSIGNED NOT NULL DEFAULT 0,
  size_bytes     INT UNSIGNED NOT NULL DEFAULT 0,
  alt            VARCHAR(255) NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Textové bloky stránky. Kľúč je stály, hodnotu mení admin.
CREATE TABLE IF NOT EXISTS blocks (
  skey        VARCHAR(100) NOT NULL,
  label       VARCHAR(190) NOT NULL DEFAULT '',
  hint        VARCHAR(255) NOT NULL DEFAULT '',
  kind        VARCHAR(20) NOT NULL DEFAULT 'text',
  section     VARCHAR(60) NOT NULL DEFAULT '',
  value       TEXT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (skey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS artists (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(120) NOT NULL,
  name          VARCHAR(160) NOT NULL,
  tag           VARCHAR(80) NOT NULL DEFAULT '',
  bio           TEXT NULL,
  media_id      INT UNSIGNED NULL,
  is_headliner  TINYINT(1) NOT NULL DEFAULT 0,
  badge         VARCHAR(80) NOT NULL DEFAULT '',
  url_facebook  VARCHAR(255) NOT NULL DEFAULT '',
  url_instagram VARCHAR(255) NOT NULL DEFAULT '',
  url_spotify   VARCHAR(255) NOT NULL DEFAULT '',
  url_youtube   VARCHAR(255) NOT NULL DEFAULT '',
  sort_order    INT NOT NULL DEFAULT 0,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL,
  updated_at    DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_artists_slug (slug),
  KEY ix_artists_order (active, is_headliner, sort_order),
  CONSTRAINT fk_artists_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tickets (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(120) NOT NULL,
  subtitle     VARCHAR(190) NOT NULL DEFAULT '',
  benefits     TEXT NULL,
  price_cents  INT UNSIGNED NULL,
  badge        VARCHAR(60) NOT NULL DEFAULT '',
  buy_url      VARCHAR(255) NOT NULL DEFAULT '',
  highlight    TINYINT(1) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL,
  updated_at   DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_tickets_order (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS faqs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  question    VARCHAR(255) NOT NULL,
  answer      TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_faqs_order (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zones (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(120) NOT NULL,
  description  TEXT NULL,
  media_id     INT UNSIGNED NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL,
  updated_at   DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_zones_order (active, sort_order),
  CONSTRAINT fk_zones_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gallery (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  media_id    INT UNSIGNED NULL,
  caption     VARCHAR(190) NOT NULL DEFAULT '',
  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_gallery_order (active, sort_order),
  CONSTRAINT fk_gallery_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS partners (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(160) NOT NULL,
  url         VARCHAR(255) NOT NULL DEFAULT '',
  media_id    INT UNSIGNED NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL,
  updated_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_partners_order (active, sort_order),
  CONSTRAINT fk_partners_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscribers (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email        VARCHAR(190) NOT NULL,
  token        VARCHAR(64) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'active',
  source       VARCHAR(40) NOT NULL DEFAULT 'web',
  ip_hash      VARCHAR(64) NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL,
  unsubscribed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscribers_email (email),
  KEY ix_subscribers_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Jednoduché okno na brzdenie opakovaných pokusov (prihlásenie, newsletter).
CREATE TABLE IF NOT EXISTS rate_limits (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket      VARCHAR(60) NOT NULL,
  ident       VARCHAR(120) NOT NULL,
  hits        INT UNSIGNED NOT NULL DEFAULT 0,
  window_end  DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rate (bucket, ident),
  KEY ix_rate_window (window_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NULL,
  username    VARCHAR(64) NOT NULL DEFAULT '',
  action      VARCHAR(60) NOT NULL,
  entity      VARCHAR(60) NOT NULL DEFAULT '',
  entity_id   VARCHAR(60) NOT NULL DEFAULT '',
  detail      TEXT NULL,
  ip          VARCHAR(64) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
