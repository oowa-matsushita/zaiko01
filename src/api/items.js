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
    where.push(`(name LIKE ?1 OR chassis_no LIKE ?1 OR color LIKE ?1 OR color_code LIKE ?1 OR sales_points LIKE ?1 OR model_no LIKE ?1 OR category LIKE ?1 OR supplier LIKE ?1 OR location LIKE ?1 OR notes LIKE ?1)`
      .replaceAll('?1', `?${args.length + 1}`));
    args.push(`%${q}%`);
  }
  const status = p.get('status');
  if (status) { where.push(`status = ?${args.length + 1}`); args.push(status); }
  const from = p.get('from');
  if (from) { where.push(`purchase_date >= ?${args.length + 1}`); args.push(from); }
  const to = p.get('to');
  if (to) { where.push(`purchase_date <= ?${args.length + 1}`); args.push(to); }

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
