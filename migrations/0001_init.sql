CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,             -- 品名
  model_no        TEXT,                         -- 型番・JAN
  category        TEXT,                         -- カテゴリ
  condition_rank  TEXT,                         -- 状態ランク (S/A/B/C/D/J)
  quantity        INTEGER NOT NULL DEFAULT 1,   -- 数量
  purchase_date   TEXT,                         -- 買取日 YYYY-MM-DD
  purchase_price  INTEGER NOT NULL DEFAULT 0,   -- 買取価格(円)
  supplier        TEXT,                         -- 仕入先・買取元
  location        TEXT,                         -- 保管場所
  list_price      INTEGER,                      -- 販売予定価格
  status          TEXT    NOT NULL DEFAULT 'in_stock', -- in_stock / listed / sold
  sold_date       TEXT,                         -- 販売日
  sold_price      INTEGER,                      -- 販売価格
  fees            INTEGER NOT NULL DEFAULT 0,   -- 手数料・送料
  notes           TEXT,                         -- メモ
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_purchase_date ON items(purchase_date);
