-- ENZO — migrácia 002 (MySQL / MariaDB)
-- Dopĺňa históriu stavov, platby ako samostatnú entitu, doručovacie zóny,
-- otváracie hodiny, kupóny, skupiny doplnkov, audit log a idempotenciu.
-- Migrácia je bezpečná aj na už bežiacej inštalácii — nič nemaže.

CREATE TABLE IF NOT EXISTS order_status_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT          NOT NULL,
  from_status VARCHAR(20)  NULL,
  to_status   VARCHAR(20)  NOT NULL,
  changed_by  INT          NULL,
  actor       VARCHAR(20)  NOT NULL DEFAULT 'system',
  reason      VARCHAR(255) NULL,
  created_at  DATETIME     NOT NULL,
  CONSTRAINT fk_osh_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id      INT          NOT NULL,
  provider      VARCHAR(30)  NOT NULL DEFAULT 'cash',
  method        VARCHAR(20)  NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
  amount_cents  INT          NOT NULL,
  currency      VARCHAR(3)   NOT NULL DEFAULT 'EUR',
  reference     VARCHAR(190) NULL,
  detail        TEXT         NULL,
  paid_at       DATETIME     NULL,
  refunded_cents INT         NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL,
  updated_at    DATETIME     NOT NULL,
  CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Referencia od providera musí byť unikátna, aby opakovaný webhook
-- nezaúčtoval tú istú platbu druhýkrát.
CREATE TABLE IF NOT EXISTS payment_events (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  payment_id   INT          NULL,
  provider     VARCHAR(30)  NOT NULL,
  event_id     VARCHAR(190) NOT NULL,
  event_type   VARCHAR(60)  NOT NULL,
  processed_at DATETIME     NOT NULL,
  UNIQUE KEY uq_payev (provider, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_zones (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  postal_codes   VARCHAR(255) NULL,
  fee_cents      INT NOT NULL DEFAULT 0,
  min_order_cents INT NOT NULL DEFAULT 0,
  free_from_cents INT NULL,
  eta_minutes    INT NOT NULL DEFAULT 45,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  position       INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS opening_hours (
  weekday    TINYINT NOT NULL PRIMARY KEY,  -- 1 = pondelok … 7 = nedeľa
  is_open    TINYINT(1)  NOT NULL DEFAULT 1,
  open_time  VARCHAR(5)  NOT NULL DEFAULT '11:00',
  close_time VARCHAR(5)  NOT NULL DEFAULT '21:00',
  -- posledná objednávka pred zatvorením (minúty)
  last_order_offset INT NOT NULL DEFAULT 30
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS closures (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  starts_at  DATETIME     NOT NULL,
  ends_at    DATETIME     NOT NULL,
  reason     VARCHAR(190) NULL,
  created_at DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS coupons (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(40)  NOT NULL UNIQUE,
  description     VARCHAR(190) NULL,
  kind            VARCHAR(20)  NOT NULL DEFAULT 'percent', -- percent | fixed | free_delivery
  value           INT          NOT NULL DEFAULT 0,          -- % alebo centy
  min_order_cents INT          NOT NULL DEFAULT 0,
  max_uses        INT          NULL,
  used_count      INT          NOT NULL DEFAULT 0,
  starts_at       DATETIME     NULL,
  ends_at         DATETIME     NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS modifier_groups (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(64)  NOT NULL UNIQUE,
  name         VARCHAR(120) NOT NULL,
  hint         VARCHAR(190) NULL,
  is_required  TINYINT(1) NOT NULL DEFAULT 0,
  min_select   INT NOT NULL DEFAULT 0,
  max_select   INT NOT NULL DEFAULT 0,   -- 0 = bez obmedzenia
  position     INT NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_modifier_groups (
  product_id INT NOT NULL,
  group_id   INT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id),
  CONSTRAINT fk_pmg_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pmg_group   FOREIGN KEY (group_id)   REFERENCES modifier_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NULL,
  user_label  VARCHAR(120) NULL,
  action      VARCHAR(60)  NOT NULL,
  entity      VARCHAR(40)  NOT NULL,
  entity_id   VARCHAR(60)  NULL,
  summary     VARCHAR(255) NULL,
  ip          VARCHAR(45)  NULL,
  created_at  DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  idem_key     VARCHAR(120) NOT NULL UNIQUE,
  scope        VARCHAR(40)  NOT NULL DEFAULT 'order',
  request_hash VARCHAR(64)  NOT NULL,
  order_id     INT          NULL,
  response     TEXT         NULL,
  created_at   DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
