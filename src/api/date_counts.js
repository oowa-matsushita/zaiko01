import { json } from '../lib.js';

// GET /api/date-counts  開催日・出庫日ごとの台数
export async function onRequestGet({ env }) {
  const [ev, sh] = await env.DB.batch([
    env.DB.prepare(`SELECT event_date AS d, COUNT(*) AS n FROM items WHERE event_date IS NOT NULL GROUP BY event_date`),
    env.DB.prepare(`SELECT shipped_date AS d, COUNT(*) AS n FROM items WHERE shipped_date IS NOT NULL GROUP BY shipped_date`),
  ]);
  const toMap = (r) => Object.fromEntries(r.results.map((x) => [x.d, x.n]));
  return json({ event_date: toMap(ev), shipped_date: toMap(sh) });
}
