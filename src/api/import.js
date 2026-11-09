import { clean, json } from '../lib.js';

// POST /api/import  { items: [...], dry_run: true|false, fill_empty: true|false }
// 車台番号が在庫にある車両・ファイル内で重複する車両はスキップし、新規だけ追加する（上書きしない）
// fill_empty=true のときだけ、既存車両の「空欄の項目」を補う（入力済みの項目は変えない）
// update_list_price=true のときは、既存車両の予定価格だけ CSV の値で上書きする
const FILLABLE = ['first_reg', 'color', 'color_code', 'mileage', 'purchase_price', 'list_price'];
const isEmpty = (k, v) => v == null || v === '' || ((k === 'purchase_price' || k === 'list_price') && v === 0);
const normChassis = (s) => String(s ?? '').normalize('NFKC').toUpperCase()
  .replace(/[ー－―‐−]/g, '-').replace(/[^A-Z0-9-]/g, '');
const MAX = 1000;
const LABEL = { first_reg: '初度登録', color: '色', color_code: 'カラーコード', mileage: '走行距離', purchase_price: '買取金額', list_price: '予定価格' };

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
      if ((body.fill_empty || body.update_list_price) && !seen.has(key)) {
        let incoming = {};
        try { incoming = clean({ ...raw, chassis_no: key }); } catch { /* 補えない */ }
        const patch = body.fill_empty ? Object.fromEntries(FILLABLE
          .filter((k) => isEmpty(k, e[k]) && !isEmpty(k, incoming[k]))
          .map((k) => [k, incoming[k]])) : {};
        // 予定価格だけは CSV の値で上書きする（CSV に値があり、今と違うときだけ）
        const set = {};
        const msgs = [];
        if (body.update_list_price && !isEmpty('list_price', incoming.list_price) && incoming.list_price !== e.list_price) {
          delete patch.list_price;
          set.list_price = incoming.list_price;
          const yen = (n) => (n ? '¥' + Math.round(n * 1.1).toLocaleString('ja-JP') : '空欄'); // 税込で表示
          msgs.push(`予定価格 ${yen(e.list_price)} → ${yen(incoming.list_price)}`);
        }
        if (Object.keys(patch).length) msgs.unshift(`空欄を補う：${Object.keys(patch).map((k) => LABEL[k]).join('・')}`);
        if (msgs.length) {
          seen.add(key);
          fills.push({ id: e.id, patch, set });
          results.push({ line, status: 'fill', message: `No.${e.id} ${e.name}：${msgs.join('／')}` });
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
    const stmts = fills.map(({ id, patch, set }) => {
      const keys = Object.keys(patch);
      // 補う項目は、念のため SQL 側でも空欄のときだけ書き込む
      const sets = keys.map((k, j) => k === 'purchase_price' || k === 'list_price'
        ? `${k} = CASE WHEN ${k} IS NULL OR ${k} = 0 THEN ?${j + 2} ELSE ${k} END`
        : `${k} = CASE WHEN ${k} IS NULL OR ${k} = '' THEN ?${j + 2} ELSE ${k} END`);
      // 上書きする項目（予定価格）
      const over = Object.keys(set);
      over.forEach((k, j) => sets.push(`${k} = ?${keys.length + j + 2}`));
      return env.DB.prepare(`UPDATE items SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?1`)
        .bind(id, ...keys.map((k) => patch[k]), ...over.map((k) => set[k]));
    });
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  if (!body.dry_run) {
    // 最後に取り込んだ日時を記録（一覧画面の「データをアップロード」の下に表示）
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)').run();
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_import', ?1)").bind(JSON.stringify({
      at: new Date().toISOString(),
      file: typeof body.file_name === 'string' ? body.file_name.slice(0, 200) : '',
      added: toInsert.length, updated: fills.length,
    })).run();
  }
  return json({
    dry_run: !!body.dry_run,
    added: body.dry_run ? 0 : toInsert.length,
    filled: body.dry_run ? 0 : fills.length,
    fill: count('fill'),
    new: count('new'), exists: count('exists'), duplicate: count('duplicate'), error: count('error'),
    results,
  });
}

// GET /api/import  最後に取り込んだ日時
export async function onRequestGet({ env }) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)').run();
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_import'").first();
  return json({ last_import: row ? JSON.parse(row.value) : null });
}
