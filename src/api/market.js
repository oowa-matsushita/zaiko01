import { json } from '../lib.js';

// オークション結果（相場）
// POST /api/market-import  { rows: [...], file_name, dry_run }  取り込み（開催日・会場・出品番号が同じものは重複としてスキップ）
// GET  /api/market-counts                                      型式ごとの件数（一覧のバッジ用）
// GET  /api/market/:id                                         在庫車両に似た車両の結果
const COLS = ['auction_date', 'venue', 'lot_no', 'year', 'model_name', 'grade', 'shift', 'cc', 'mileage_k',
  'inspection', 'color', 'type_code', 'equipment', 'result', 'region', 'price_k', 'start_k', 'score', 'serial', 'interior'];

export async function ensureMarketTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS auction_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_date TEXT, venue TEXT, lot_no TEXT, year TEXT, model_name TEXT, grade TEXT, shift TEXT, cc INTEGER,
    mileage_k INTEGER, inspection TEXT, color TEXT, type_code TEXT, equipment TEXT, result TEXT, region TEXT,
    price_k INTEGER, start_k INTEGER, score TEXT, serial TEXT, interior TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (auction_date, venue, lot_no))`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_auction_type ON auction_results(type_code)').run();
}

const norm = (s) => String(s ?? '').normalize('NFKC').toUpperCase().replace(/\s/g, '');
// 車台番号 MH34S-748370 → { type: MH34S, serial: 748370 }
function splitChassis(c) {
  const s = norm(c);
  const i = s.indexOf('-');
  return i < 0 ? { type: s.replace(/\d{5,}$/, ''), serial: (s.match(/\d{5,}$/) || [''])[0] } : { type: s.slice(0, i), serial: s.slice(i + 1) };
}

export async function importRows({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSONを送ってください' }, 400); }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ error: 'データがありません' }, 400);
  if (rows.length > 5000) return json({ error: '一度に取り込めるのは5000件までです' }, 400);
  await ensureMarketTable(env.DB);
  const have = new Set((await env.DB.prepare('SELECT auction_date, venue, lot_no FROM auction_results').all())
    .results.map((r) => `${r.auction_date}|${r.venue}|${r.lot_no}`));
  const fresh = [];
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.auction_date}|${r.venue}|${r.lot_no}`;
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    fresh.push(r);
  }
  if (!body.dry_run && fresh.length) {
    const stmts = fresh.map((r) => env.DB.prepare(
      `INSERT OR IGNORE INTO auction_results (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `?${i + 1}`).join(', ')})`
    ).bind(...COLS.map((c) => (r[c] === '' || r[c] === undefined ? null : r[c]))));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  }
  return json({ dry_run: !!body.dry_run, total: rows.length, new: fresh.length, duplicate: rows.length - fresh.length });
}

export async function counts({ env }) {
  await ensureMarketTable(env.DB);
  const r = await env.DB.prepare('SELECT type_code, COUNT(*) AS n FROM auction_results GROUP BY type_code').all();
  return json({ types: Object.fromEntries(r.results.map((x) => [norm(x.type_code), x.n])) });
}

// 年式（H25 / R06 / 平成25年06月 / 2013）→ 西暦
const ERA = { S: 1925, H: 1988, R: 2018, 昭和: 1925, 平成: 1988, 令和: 2018 };
function westernYear(s) {
  const t = String(s || '').normalize('NFKC').toUpperCase();
  const m = t.match(/^([SHR])\s*(\d{1,2})/) || t.match(/(昭和|平成|令和)\s*(\d+|元)/);
  if (m) return ERA[m[1]] + (m[2] === '元' ? 1 : Number(m[2]));
  const w = t.match(/(19|20)\d{2}/);
  return w ? Number(w[0]) : null;
}

export async function forItem({ env, params }) {
  await ensureMarketTable(env.DB);
  const item = await env.DB.prepare('SELECT id, name, chassis_no, first_reg, mileage, mileage_unit FROM items WHERE id = ?1').bind(Number(params.id)).first();
  if (!item) return json({ error: '見つかりません' }, 404);
  const { type, serial } = splitChassis(item.chassis_no);
  if (!type) return json({ type: '', own: [], similar: [] });
  // 型式は「NCP81」と「NCP81G」のように末尾が違うことがあるので前方一致で探す
  const list = (await env.DB.prepare(
    `SELECT * FROM auction_results WHERE UPPER(REPLACE(type_code, ' ', '')) LIKE ?1 ORDER BY auction_date DESC LIMIT 300`
  ).bind(`${type}%`).all()).results;
  const year = westernYear(item.first_reg);
  const km = item.mileage == null ? null : (item.mileage_unit === 'mile' ? item.mileage * 1.609344 : item.mileage) / 1000;
  const own = [], others = [];
  for (const r of list) {
    const rec = { ...r, west_year: westernYear(r.year) };
    if (serial && norm(r.serial) === serial) own.push(rec); else others.push(rec);
  }
  // 似ている順：年式の差（1年＝走行2万km相当）と走行距離の差
  const dist = (r) => (year && r.west_year ? Math.abs(year - r.west_year) * 20 : 10) + (km != null && r.mileage_k != null ? Math.abs(km - r.mileage_k) : 10);
  others.sort((a, b) => dist(a) - dist(b) || (b.auction_date || '').localeCompare(a.auction_date || ''));
  const sold = others.filter((r) => /落札/.test(r.result || '') && r.price_k > 0).map((r) => r.price_k);
  const stat = sold.length ? {
    n: sold.length, avg: Math.round(sold.reduce((a, b) => a + b, 0) / sold.length),
    min: Math.min(...sold), max: Math.max(...sold),
  } : null;
  return json({ type, own, similar: others.slice(0, 12), similar_total: others.length, stat });
}
