import { clean, json, PROFIT_SQL } from '../lib.js';

const SORTS = {
  purchase_date_desc: 'purchase_date DESC, id DESC',
  purchase_date_asc: 'purchase_date ASC, id ASC',
  updated_desc: 'updated_at DESC, id DESC',
  price_desc: 'purchase_price DESC, id DESC',
  mileage_asc: 'mileage IS NULL, mileage ASC, id DESC',
  mileage_desc: 'mileage IS NULL, mileage DESC, id DESC',
  created_desc: 'id DESC',
  created_asc: 'id ASC',
};

// GET /api/items?q=&status=&from=&to=&sort=&limit=&offset=
export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const where = [];
  const args = [];
  const q = p.get('q');
  if (q) {
    where.push(`(name LIKE ?1 OR grade LIKE ?1 OR chassis_no LIKE ?1 OR plate_no LIKE ?1 OR color LIKE ?1 OR color_code LIKE ?1 OR sales_points LIKE ?1 OR venue LIKE ?1 OR carrier LIKE ?1 OR model_no LIKE ?1 OR category LIKE ?1 OR supplier LIKE ?1 OR location LIKE ?1 OR notes LIKE ?1)`
      .replaceAll('?1', `?${args.length + 1}`));
    args.push(`%${q}%`);
  }
  const status = p.get('status');
  if (status) { where.push(`status = ?${args.length + 1}`); args.push(status); }
  const from = p.get('from');
  if (from) { where.push(`purchase_date >= ?${args.length + 1}`); args.push(from); }
  const to = p.get('to');
  if (to) { where.push(`purchase_date <= ?${args.length + 1}`); args.push(to); }
  // 出庫前のみ：出庫日が今日以降、または出庫日が未定（today は日本時間 YYYY-MM-DD）
  const before = p.get('before_ship');
  if (before && /^\d{4}-\d{2}-\d{2}$/.test(before)) {
    where.push(`(shipped_date IS NULL OR shipped_date = '' OR shipped_date >= ?${args.length + 1})`);
    args.push(before);
  }
  // 自社名（日付）が入っているかで絞り込み：own=done 入力済み / own=wait 未入力
  const own = p.get('own');
  if (own === 'done') where.push("(own_date IS NOT NULL AND own_date <> '')");
  if (own === 'wait') where.push("(own_date IS NULL OR own_date = '')");
  // 陸送会社で絞り込み（carrier=none は未選択の車両）
  const carrier = p.get('carrier');
  if (carrier === 'none') where.push("(carrier IS NULL OR carrier = '')");
  else if (carrier) { where.push(`carrier = ?${args.length + 1}`); args.push(carrier); }
  for (const f of ['event_date', 'shipped_date', 'venue']) {
    const v = p.get(f);
    if (v) { where.push(`${f} = ?${args.length + 1}`); args.push(v); }
  }

  const order = SORTS[p.get('sort')] || SORTS.created_desc;
  const limit = Math.min(Math.max(parseInt(p.get('limit') || '200', 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await env.DB.prepare(
    `SELECT *, ${PROFIT_SQL} AS profit FROM items ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
  ).bind(...args).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items ${w}`).bind(...args).first();
  return json({ items: rows.results, total: total.n });
}

// POST /api/items  { name, purchase_price, ... }
export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = clean(await request.json());
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  const keys = Object.keys(data);
  const sql = `INSERT INTO items (${keys.join(', ')}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(', ')})
               RETURNING *, ${PROFIT_SQL} AS profit`;
  const row = await env.DB.prepare(sql).bind(...keys.map((k) => data[k])).first();
  return json(row, 201);
}

// POST /api/plate-request  { ids: [1, 2, ...] }
// ナンバー外し依頼を出した車両の「依頼回数」を 1 つ増やす（PDF を出したときに画面から呼ぶ）
export async function plateRequest({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSONを送ってください' }, 400); }
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number))];
  if (!ids.length || ids.length > 1000 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    return json({ error: 'ids に車両の番号を 1〜1000 件、送ってください' }, 400);
  }
  const stmts = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    stmts.push(env.DB.prepare(`UPDATE items SET plate_requests = COALESCE(plate_requests, 0) + 1 WHERE id IN (${part.map((_, j) => `?${j + 1}`).join(', ')})`).bind(...part));
  }
  const res = await env.DB.batch(stmts);
  return json({ ok: true, updated: res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0) });
}
