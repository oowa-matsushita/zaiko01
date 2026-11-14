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

const insertStmt = (db, r) => db.prepare(
  `INSERT OR IGNORE INTO auction_results (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `?${i + 1}`).join(', ')})`
).bind(...COLS.map((c) => (r[c] === '' || r[c] === undefined ? null : r[c])));

// first に渡した文（全削除など）は最初のまとまりと一緒に実行する
async function insertRows(db, rows, first = []) {
  const stmts = [...first, ...rows.map((r) => insertStmt(db, r))];
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

// 行の形と中身の確認（Claude から送られたデータ用）
function checkRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'データがありません';
  if (rows.length > 5000) return '一度に送れるのは5000件までです';
  const bad = rows.findIndex((r) => !r || typeof r !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(r.auction_date || '') || !r.venue || !r.lot_no);
  if (bad >= 0) return `${bad + 1} 件目：開催日（YYYY-MM-DD）・会場・出品番号は必須です`;
  return '';
}

// POST /api/market-replace  { rows, dry_run }  相場データを全部消して入れ直す（Claude 用）
export async function replaceAll({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSONを送ってください' }, 400); }
  const err = checkRows(body.rows);
  if (err) return json({ error: err }, 400);
  await ensureMarketTable(env.DB);
  const seen = new Set();
  const rows = body.rows.filter((r) => { const k = `${r.auction_date}|${r.venue}|${r.lot_no}`; return !seen.has(k) && seen.add(k); });
  const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM auction_results').first()).n;
  if (!body.dry_run) await insertRows(env.DB, rows, [env.DB.prepare('DELETE FROM auction_results')]);
  return json({ dry_run: !!body.dry_run, deleted: before, inserted: rows.length, duplicate: body.rows.length - rows.length });
}

// GET /api/market-summary  件数・期間・会場別件数（Claude の確認用）
export async function summary({ env }) {
  await ensureMarketTable(env.DB);
  const all = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(auction_date) AS first, MAX(auction_date) AS last, SUM(year IS NOT NULL) AS with_year FROM auction_results').first();
  const venues = (await env.DB.prepare('SELECT venue, COUNT(*) AS n FROM auction_results GROUP BY venue ORDER BY n DESC').all()).results;
  return json({ ...all, venues });
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
  if (!body.dry_run && fresh.length) await insertRows(env.DB, fresh);
  return json({ dry_run: !!body.dry_run, total: rows.length, new: fresh.length, duplicate: rows.length - fresh.length });
}

// GET /api/market-list?q=&result=sold|unsold&from=&to=  AA結果の一覧
export async function list({ request, env }) {
  await ensureMarketTable(env.DB);
  const p = new URL(request.url).searchParams;
  const where = [], args = [];
  const q = (p.get('q') || '').normalize('NFKC').trim();
  if (q) {
    for (const w of q.split(/\s+/)) {
      const i = args.length + 1;
      where.push(`(model_name LIKE ?${i} OR grade LIKE ?${i} OR type_code LIKE ?${i} OR serial LIKE ?${i} OR color LIKE ?${i} OR venue LIKE ?${i} OR lot_no = ?${i + 1} OR region LIKE ?${i})`);
      args.push(`%${w}%`, w);
    }
  }
  const r = p.get('result');
  if (r === 'sold') where.push("result LIKE '%落札%'");
  if (r === 'unsold') where.push("result NOT LIKE '%落札%'");
  if (p.get('from')) { where.push(`auction_date >= ?${args.length + 1}`); args.push(p.get('from')); }
  if (p.get('to')) { where.push(`auction_date <= ?${args.length + 1}`); args.push(p.get('to')); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = (await env.DB.prepare(`SELECT * FROM auction_results ${w} ORDER BY auction_date DESC, CAST(lot_no AS INTEGER) LIMIT 3000`).bind(...args).all()).results;
  const dates = (await env.DB.prepare('SELECT DISTINCT auction_date FROM auction_results ORDER BY auction_date DESC').all()).results.map((x) => x.auction_date);
  // 在庫にある車両（型式＋車台番号が一致）に印を付ける
  const stock = new Set((await env.DB.prepare("SELECT chassis_no FROM items WHERE chassis_no IS NOT NULL AND chassis_no <> ''").all())
    .results.map((x) => { const c = splitChassis(x.chassis_no); return `${c.type}|${c.serial}`; }));
  for (const row of rows) {
    const t = norm(row.type_code), sn = norm(row.serial);
    row.in_stock = [...stock].some((k) => { const [st, ss] = k.split('|'); return ss === sn && t.startsWith(st); });
  }
  return json({ rows, dates });
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

// 中央値（偶数件のときは真ん中2つの平均）
function median(list) {
  const a = [...list].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
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
    n: sold.length, avg: Math.round(sold.reduce((a, b) => a + b, 0) / sold.length), median: median(sold),
    min: Math.min(...sold), max: Math.max(...sold),
  } : null;
  return json({ type, own, similar: others.slice(0, 12), similar_total: others.length, stat });
}
