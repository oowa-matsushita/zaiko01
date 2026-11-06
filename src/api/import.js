import { clean, json } from '../lib.js';

// POST /api/import  { items: [...], dry_run: true|false, fill_empty: true|false }
// 車台番号が在庫にある車両・ファイル内で重複する車両はスキップし、新規だけ追加する（上書きしない）
// fill_empty=true のときだけ、既存車両の「空欄の項目」を補う（入力済みの項目は変えない）
const FILLABLE = ['first_reg', 'color', 'color_code', 'mileage', 'purchase_price'];
const isEmpty = (k, v) => v == null || v === '' || (k === 'purchase_price' && v === 0);
const normChassis = (s) => String(s ?? '').normalize('NFKC').toUpperCase()
  .replace(/[ー－―‐−]/g, '-').replace(/[^A-Z0-9-]/g, '');
const MAX = 1000;
const LABEL = { first_reg: '初度登録', color: '色', color_code: 'カラーコード', mileage: '走行距離', purchase_price: '買取金額' };

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSONを送ってください' }, 400); }
  const list = Array.isArray(body.items) ? body.items : null;
  if (!list) return json({ error: 'items がありません' }, 400);
  if (list.length > MAX) return json({ error: `一度に取り込めるのは${MAX}台までです` }, 400);

  const existing = await env.DB.prepare(
    `SELECT id, chassis_no, name, ${FILLABLE.join(', ')} FROM items WHERE chassis_no IS NOT NULL AND chassis_no <> ''`
  ).all();
  const fills = [];
  const have = new Map(existing.results.map((r) => [normChassis(r.chassis_no), r]));
  const seen = new Set();

  const results = [];
  const toInsert = [];
  for (const [i, raw] of list.entries()) {
    const line = raw?.line ?? i + 1;
    const key = normChassis(raw?.chassis_no);
    if (!key) { results.push({ line, status: 'error', message: '車台番号がありません' }); continue; }
    if (have.has(key)) {
      const e = have.get(key);
      if (body.fill_empty && !seen.has(key)) {
        let incoming = {};
        try { incoming = clean({ ...raw, chassis_no: key }); } catch { /* 補えない */ }
        const patch = Object.fromEntries(FILLABLE
          .filter((k) => isEmpty(k, e[k]) && !isEmpty(k, incoming[k]))
          .map((k) => [k, incoming[k]]));
        if (Object.keys(patch).length) {
          seen.add(key);
          fills.push({ id: e.id, patch });
          results.push({ line, status: 'fill', message: `No.${e.id} ${e.name} の空欄を補う：${Object.keys(patch).map((k) => LABEL[k]).join('・')}` });
          continue;
        }
      }
      seen.add(key);
      results.push({ line, status: 'exists', message: `在庫にあります（No.${e.id} ${e.name}）` });
      continue;
    }
    if (seen.has(key)) { results.push({ line, status: 'duplicate', message: 'ファイル内で重複しています' }); continue; }
    let data;
    try {
      data = clean({ ...raw, chassis_no: key });
    } catch (e) {
      results.push({ line, status: 'error', message: e.message });
      continue;
    }
    seen.add(key);
    results.push({ line, status: 'new' });
    toInsert.push(data);
  }

  if (!body.dry_run && toInsert.length) {
    const stmts = toInsert.map((d) => {
      const keys = Object.keys(d);
      return env.DB.prepare(`INSERT INTO items (${keys.join(', ')}) VALUES (${keys.map((_, j) => `?${j + 1}`).join(', ')})`)
        .bind(...keys.map((k) => d[k]));
    });
    // 100件ずつまとめて登録（各まとまりは1回のトランザクション）
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  }
  if (!body.dry_run && fills.length) {
    const stmts = fills.map(({ id, patch }) => {
      const keys = Object.keys(patch);
      // 念のため SQL 側でも空欄のときだけ書き込む
      const sets = keys.map((k, j) => k === 'purchase_price'
        ? `${k} = CASE WHEN ${k} IS NULL OR ${k} = 0 THEN ?${j + 2} ELSE ${k} END`
        : `${k} = CASE WHEN ${k} IS NULL OR ${k} = '' THEN ?${j + 2} ELSE ${k} END`).join(', ');
      return env.DB.prepare(`UPDATE items SET ${sets}, updated_at = datetime('now') WHERE id = ?1`).bind(id, ...keys.map((k) => patch[k]));
    });
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return json({
    dry_run: !!body.dry_run,
    added: body.dry_run ? 0 : toInsert.length,
    filled: body.dry_run ? 0 : fills.length,
    fill: count('fill'),
    new: count('new'), exists: count('exists'), duplicate: count('duplicate'), error: count('error'),
    results,
  });
}
