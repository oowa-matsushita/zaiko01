import { json } from '../lib.js';

// 月初在庫（毎月の在庫一覧CSV）を月ごとに保存し、回転率を出す
//   販売台数（自動）= その月の月初在庫にあって、翌月の月初在庫にない車の台数
//   仕入台数（自動）= 翌月の月初在庫にあって、その月の月初在庫にない車の台数
//   回転率 = 販売台数 ÷ 月初在庫台数（販売台数は手入力があればそちらを使う）
// 1か月分の車両は data 列に JSON でまとめて保存する（1,000台を超えても1行で済むように）

let ready = null;
export function ensureSnapshots(db) {
  ready ??= db.prepare(`CREATE TABLE IF NOT EXISTS stock_snapshots (
      ym TEXT PRIMARY KEY, file_name TEXT, uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      count INTEGER NOT NULL, cost_total INTEGER NOT NULL DEFAULT 0,
      sold_auto INTEGER, bought_auto INTEGER, sold_manual INTEGER, data TEXT NOT NULL)`).run()
    .catch((e) => { ready = null; throw e; });
  return ready;
}

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const shift = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
// 同じ車かどうかは車台番号で判定（なければ在庫No）
const keyOf = (r) => r.chassis || r.no;
const MAX_ROWS = 5000;
const LIST_COLS = 'ym, file_name, uploaded_at, count, cost_total, sold_auto, bought_auto, sold_manual';

const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const int = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
function cleanRow(r) {
  const inDate = str(r?.in, 10);
  return {
    no: str(r?.no, 30), maker: str(r?.maker, 30), name: str(r?.name), reg: str(r?.reg, 20),
    color: str(r?.color), km: int(r?.km), type: str(r?.type, 30), chassis: str(r?.chassis, 40),
    list: int(r?.list), cost: int(r?.cost), in: /^\d{4}-\d{2}-\d{2}$/.test(inDate) ? inDate : '',
  };
}

function diff(cur, next) {
  const kn = new Set(next.map(keyOf));
  const kc = new Set(cur.map(keyOf));
  return { sold: cur.filter((r) => !kn.has(keyOf(r))), bought: next.filter((r) => !kc.has(keyOf(r))) };
}

async function loadRows(db, ym) {
  const row = await db.prepare('SELECT data FROM stock_snapshots WHERE ym = ?1').bind(ym).first();
  return row ? JSON.parse(row.data) : null;
}

// ym の販売台数・仕入台数（自動）を、ym と翌月の月初在庫から計算し直す
async function recompute(db, ym) {
  const cur = await loadRows(db, ym);
  if (!cur) return;
  const next = await loadRows(db, shift(ym, 1));
  const d = next ? diff(cur, next) : null;
  await db.prepare('UPDATE stock_snapshots SET sold_auto = ?2, bought_auto = ?3 WHERE ym = ?1')
    .bind(ym, d ? d.sold.length : null, d ? d.bought.length : null).run();
}

const list = async (db) => (await db.prepare(`SELECT ${LIST_COLS} FROM stock_snapshots ORDER BY ym DESC`).all()).results;

// GET /api/snapshots  月ごとの一覧（車両データは含めない）
export async function onRequestGet({ env }) {
  await ensureSnapshots(env.DB);
  return json({ months: await list(env.DB) });
}

// POST /api/snapshots  { ym: 'YYYY-MM', file_name, rows: [...] }  その月の月初在庫を保存（同じ月は上書き）
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSONを送ってください' }, 400); }
  const ym = String(body?.ym || '');
  if (!YM.test(ym)) return json({ error: '月の形式が正しくありません（例：2026-10）' }, 400);
  if (!Array.isArray(body.rows) || !body.rows.length) return json({ error: '車両がありません' }, 400);
  if (body.rows.length > MAX_ROWS) return json({ error: `一度に取り込めるのは${MAX_ROWS}台までです` }, 400);
  const rows = body.rows.map(cleanRow).filter((r) => keyOf(r));
  if (!rows.length) return json({ error: '車台番号・在庫Noのある車両がありません' }, 400);
  const cost = rows.reduce((s, r) => s + (r.cost || 0), 0);

  await ensureSnapshots(env.DB);
  await env.DB.prepare(`INSERT INTO stock_snapshots (ym, file_name, uploaded_at, count, cost_total, data)
      VALUES (?1, ?2, datetime('now'), ?3, ?4, ?5)
      ON CONFLICT(ym) DO UPDATE SET file_name = excluded.file_name, uploaded_at = excluded.uploaded_at,
        count = excluded.count, cost_total = excluded.cost_total, data = excluded.data`)
    .bind(ym, str(body.file_name, 120), rows.length, cost, JSON.stringify(rows)).run();
  await recompute(env.DB, ym);
  await recompute(env.DB, shift(ym, -1));
  return json({ ym, count: rows.length, skipped: body.rows.length - rows.length, months: await list(env.DB) }, 201);
}

// /api/snapshots/:ym
// GET    その月の月初在庫の車両と、翌月があれば販売した車・仕入れた車
export async function onRequestGet_ym({ env, params }) {
  await ensureSnapshots(env.DB);
  const ym = params.ym;
  const head = YM.test(ym) && await env.DB.prepare(`SELECT ${LIST_COLS} FROM stock_snapshots WHERE ym = ?1`).bind(ym).first();
  if (!head) return json({ error: 'この月の月初在庫はありません' }, 404);
  const cur = await loadRows(env.DB, ym);
  const next = await loadRows(env.DB, shift(ym, 1));
  return json({ ...head, rows: cur, ...(next ? diff(cur, next) : { sold: null, bought: null }) });
}

// PATCH  { sold_manual: 数値 | null }  販売台数の手入力（null で自動に戻す）
export async function onRequestPatch_ym({ request, env, params }) {
  await ensureSnapshots(env.DB);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSONを送ってください' }, 400); }
  const v = body?.sold_manual;
  const n = v === null || v === '' ? null : int(v);
  if (v !== null && v !== '' && n === null) return json({ error: '販売台数は0以上の数字で入力してください' }, 400);
  const r = await env.DB.prepare('UPDATE stock_snapshots SET sold_manual = ?2 WHERE ym = ?1').bind(params.ym, n).run();
  if (!r.meta.changes) return json({ error: 'この月の月初在庫はありません' }, 404);
  return json({ months: await list(env.DB) });
}

// DELETE  その月の月初在庫を削除
export async function onRequestDelete_ym({ env, params }) {
  await ensureSnapshots(env.DB);
  const r = await env.DB.prepare('DELETE FROM stock_snapshots WHERE ym = ?1').bind(params.ym).run();
  if (!r.meta.changes) return json({ error: 'この月の月初在庫はありません' }, 404);
  if (YM.test(params.ym)) await recompute(env.DB, shift(params.ym, -1));
  return json({ months: await list(env.DB) });
}
