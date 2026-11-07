import { json } from '../lib.js';

// GET /api/date-counts  開催日・出庫日ごとの台数
export async function onRequestGet({ env }) {
  const [ev, sh, sc] = await env.DB.batch([
    env.DB.prepare(`SELECT event_date AS d, COUNT(*) AS n FROM items WHERE event_date IS NOT NULL GROUP BY event_date`),
    env.DB.prepare(`SELECT shipped_date AS d, COUNT(*) AS n FROM items WHERE shipped_date IS NOT NULL GROUP BY shipped_date`),
    // 出庫日ごと・陸送会社ごとの台数（陸送会社が入っている車両のみ）
    env.DB.prepare(`SELECT shipped_date AS d, carrier AS c, COUNT(*) AS n FROM items
      WHERE shipped_date IS NOT NULL AND carrier IS NOT NULL AND carrier <> '' GROUP BY shipped_date, carrier`),
  ]);
  const toMap = (r) => Object.fromEntries(r.results.map((x) => [x.d, x.n]));
  const shippedCarriers = {};
  for (const x of sc.results) (shippedCarriers[x.d] ??= {})[x.c] = x.n;
  return json({ event_date: toMap(ev), shipped_date: toMap(sh), shipped_carriers: shippedCarriers });
}
