-- ENZO — schéma databázy (MySQL / MariaDB)
-- Ceny sú v celých centoch (INT), aby nevznikali zaokrúhľovacie chyby.

CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(64)  NOT NULL PRIMARY KEY,
  `value`     TEXT         NULL,
  updated_at  DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  name          VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'staff',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at DATETIME     NULL,
  created_at    DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(64)  NOT NULL UNIQUE,
  label       VARCHAR(64)  NOT NULL,
  title       VARCHAR(120) NOT NULL,
  caption     VARCHAR(255) NULL,
  position    INT          NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(80)  NOT NULL UNIQUE,
  category_id  INT          NOT NULL,
  name         VARCHAR(160) NOT NULL,
  description  TEXT         NULL,
  price_cents  INT          NOT NULL,
  image        VARCHAR(255) NULL,
  image_alt    VARCHAR(255) NULL,
  badge        VARCHAR(60)  NULL,
  tags         VARCHAR(255) NULL,
  lid_accent   VARCHAR(20)  NULL,
  lid_line1    VARCHAR(30)  NULL,
  lid_line2    VARCHAR(30)  NULL,
  vat_group    VARCHAR(10)  NOT NULL DEFAULT 'food',
  is_available TINYINT(1)   NOT NULL DEFAULT 1,
  position     INT          NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL,
  updated_at   DATETIME     NOT NULL,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS extras (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  slug        VARCHAR(64)  NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  price_cents INT          NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  position    INT          NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_extras (
  product_id INT NOT NULL,
  extra_id   INT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, extra_id),
  CONSTRAINT fk_pe_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pe_extra   FOREIGN KEY (extra_id)   REFERENCES extras(id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  order_number       VARCHAR(30)  NOT NULL UNIQUE,
  doc_number         VARCHAR(30)  NULL UNIQUE,
  access_token       VARCHAR(64)  NOT NULL,
  status             VARCHAR(20)  NOT NULL DEFAULT 'received',
  order_type         VARCHAR(20)  NOT NULL,
  payment_method     VARCHAR(20)  NOT NULL,
  payment_status     VARCHAR(20)  NOT NULL DEFAULT 'unpaid',
  payment_reference  VARCHAR(190) NULL,
  paid_at            DATETIME     NULL,

  first_name  VARCHAR(80)  NOT NULL,
  last_name   VARCHAR(80)  NOT NULL,
  phone       VARCHAR(40)  NOT NULL,
  email       VARCHAR(190) NOT NULL,
  street      VARCHAR(160) NULL,
  house_number VARCHAR(30) NULL,
  city        VARCHAR(120) NULL,
  postal_code VARCHAR(20)  NULL,
  note        TEXT         NULL,
  pickup_time VARCHAR(60)  NULL,

  subtotal_cents     INT NOT NULL,
  delivery_fee_cents INT NOT NULL DEFAULT 0,
  total_cents        INT NOT NULL,
  vat_breakdown      TEXT NULL,

  ready_at        DATETIME NULL,
  prep_minutes    INT      NULL,
  confirmed_at    DATETIME NULL,
  completed_at    DATETIME NULL,
  cancelled_at    DATETIME NULL,
  cancel_reason   VARCHAR(255) NULL,

  customer_ip  VARCHAR(45) NULL,
  user_agent   VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL,
  updated_at   DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  order_id       INT NOT NULL,
  product_slug   VARCHAR(80)  NULL,
  name           VARCHAR(160) NOT NULL,
  base_cents     INT NOT NULL,
  extras_cents   INT NOT NULL DEFAULT 0,
  unit_cents     INT NOT NULL,
  quantity       INT NOT NULL,
  line_cents     INT NOT NULL,
  extras_json    TEXT NULL,
  note           VARCHAR(255) NULL,
  vat_group      VARCHAR(10) NOT NULL DEFAULT 'food',
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_events (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  order_id   INT NOT NULL,
  event      VARCHAR(40)  NOT NULL,
  detail     VARCHAR(255) NULL,
  user_id    INT NULL,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_events_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mail_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT NULL,
  recipient   VARCHAR(190) NOT NULL,
  subject     VARCHAR(255) NOT NULL,
  template    VARCHAR(60)  NOT NULL,
  status      VARCHAR(20)  NOT NULL,
  error       TEXT         NULL,
  created_at  DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limit (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  ip         VARCHAR(45) NOT NULL,
  action     VARCHAR(40) NOT NULL,
  created_at DATETIME    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

