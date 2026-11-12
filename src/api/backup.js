import { json, ensureSchema } from '../lib.js';
import { ensureMarketTable } from './market.js';

// 全データのバックアップと復元（サイトの移設・保管用）
// GET  /api/backup   在庫・AA結果・設定を1つのJSONでダウンロード
// POST /api/restore  バックアップのJSONを読み込む（在庫が空のときだけ。上書き事故を防ぐため）
const TABLES = ['items', 'auction_results', 'meta'];

async function ensureAll(db) {
  await ensureSchema(db);
  await ensureMarketTable(db);
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)').run();
}

export async function download({ env }) {
  await ensureAll(env.DB);
  const out = { app: 'zaiko01', version: 1, exported_at: new Date().toISOString() };
  for (const t of TABLES) out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  const d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="zaiko01_backup_${d}.json"`,
      'cache-control': 'no-store',
    },
  });
}

export async function restore({ request, env }) {
  let data;
  try { data = await request.json(); } catch { return json({ error: 'バックアップのファイルを読み込めませんでした' }, 400); }
  if (data?.app !== 'zaiko01' || !Array.isArray(data.items)) return json({ error: 'このサイトのバックアップファイルではありません' }, 400);
  await ensureAll(env.DB);
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM items').first();
  if (cnt.n > 0) return json({ error: `在庫に ${cnt.n} 台入っているため復元できません（空のサイトにだけ復元できます）` }, 409);

  const result = {};
  for (const t of TABLES) {
    const rows = Array.isArray(data[t]) ? data[t] : [];
    const cols = new Set((await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name));
    const stmts = rows.map((r) => {
      const keys = Object.keys(r).filter((k) => cols.has(k));
      return env.DB.prepare(`INSERT OR REPLACE INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(', ')})`)
        .bind(...keys.map((k) => r[k]));
    });
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    result[t] = rows.length;
  }
  return json({ ok: true, restored: result });
}
