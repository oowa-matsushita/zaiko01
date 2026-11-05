import { clean, json, PROFIT_SQL } from '../../../lib/items.js';

function getId(params) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function onRequestGet({ params, env }) {
  const id = getId(params);
  const row = id && await env.DB.prepare(`SELECT *, ${PROFIT_SQL} AS profit FROM items WHERE id = ?1`).bind(id).first();
  return row ? json(row) : json({ error: '見つかりません' }, 404);
}

// PUT / PATCH は指定した項目だけ更新
async function update({ params, request, env }) {
  const id = getId(params);
  if (!id) return json({ error: '見つかりません' }, 404);
  let data;
  try {
    data = clean(await request.json(), true);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  const keys = Object.keys(data);
  if (!keys.length) return json({ error: '更新する項目がありません' }, 400);
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(', ');
  const row = await env.DB.prepare(
    `UPDATE items SET ${sets}, updated_at = datetime('now') WHERE id = ?1 RETURNING *, ${PROFIT_SQL} AS profit`
  ).bind(id, ...keys.map((k) => data[k])).first();
  return row ? json(row) : json({ error: '見つかりません' }, 404);
}
export const onRequestPut = update;
export const onRequestPatch = update;

export async function onRequestDelete({ params, env }) {
  const id = getId(params);
  const r = id && await env.DB.prepare('DELETE FROM items WHERE id = ?1').bind(id).run();
  return r && r.meta.changes ? json({ ok: true }) : json({ error: '見つかりません' }, 404);
}
