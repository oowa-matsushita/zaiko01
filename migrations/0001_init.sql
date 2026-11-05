-- 在庫テーブル（D1コンソールに貼る場合は1文ずつ貼ってください）
CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, model_no TEXT, category TEXT, condition_rank TEXT, quantity INTEGER NOT NULL DEFAULT 1, purchase_date TEXT, purchase_price INTEGER NOT NULL DEFAULT 0, supplier TEXT, location TEXT, list_price INTEGER, status TEXT NOT NULL DEFAULT 'in_stock', sold_date TEXT, sold_price INTEGER, fees INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_purchase_date ON items(purchase_date);
