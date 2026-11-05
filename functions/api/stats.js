import { json } from '../../lib/items.js';

// GET /api/stats?month=YYYY-MM  在庫状況と月別の売上・利益
export async function onRequestGet({ request, env }) {
  const month = new URL(request.url).searchParams.get('month');
  const stock = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count, COALESCE(SUM(quantity),0) AS quantity,
            COALESCE(SUM(purchase_price),0) AS purchase_total
     FROM items GROUP BY status`
  ).all();
  const monthly = await env.DB.prepare(
    `SELECT substr(sold_date,1,7) AS month, COUNT(*) AS sold_count,
            COALESCE(SUM(sold_price),0) AS sales,
            COALESCE(SUM(sold_price - purchase_price - fees),0) AS profit
     FROM items WHERE status = 'sold' AND sold_date IS NOT NULL
       ${month ? "AND substr(sold_date,1,7) = ?1" : ''}
     GROUP BY month ORDER BY month DESC LIMIT 12`
  ).bind(...(month ? [month] : [])).all();
  const purchases = await env.DB.prepare(
    `SELECT substr(purchase_date,1,7) AS month, COUNT(*) AS count,
            COALESCE(SUM(purchase_price),0) AS purchase_total
     FROM items WHERE purchase_date IS NOT NULL
     GROUP BY month ORDER BY month DESC LIMIT 12`
  ).all();
  return json({ stock: stock.results, monthly_sales: monthly.results, monthly_purchases: purchases.results });
}
