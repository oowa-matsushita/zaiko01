// Cloudflare Workers のエントリ。ログインを確認し、/api/* をここで処理、それ以外は public/ の静的ファイルを返す
import * as items from './api/items.js';
import * as item from './api/item.js';
import * as stats from './api/stats.js';
import * as dateCounts from './api/date_counts.js';
import * as ocrPlate from './api/ocr_plate.js';
import * as importItems from './api/import.js';
import * as market from './api/market.js';
import * as backup from './api/backup.js';
import { json, ensureSchema } from './lib.js';
import { isLoggedIn, handleLogin, handleLogout, loginPage } from './auth.js';

const ROUTES = [
  [/^\/api\/items\/?$/, items],
  [/^\/api\/items\/(?<id>[^/]+)\/?$/, item],
  [/^\/api\/stats\/?$/, stats],
  [/^\/api\/date-counts\/?$/, dateCounts],
  [/^\/api\/ocr-plate\/?$/, ocrPlate],
  [/^\/api\/import\/?$/, importItems],
  [/^\/api\/market-import\/?$/, { onRequestPost: market.importRows }],
  [/^\/api\/market-counts\/?$/, { onRequestGet: market.counts }],
  [/^\/api\/market-list\/?$/, { onRequestGet: market.list }],
  [/^\/api\/backup\/?$/, { onRequestGet: backup.download }],
  [/^\/api\/restore\/?$/, { onRequestPost: backup.restore }],
  [/^\/api\/market\/(?<id>\d+)\/?$/, { onRequestGet: market.forItem }],
];
const METHOD = { GET: 'onRequestGet', POST: 'onRequestPost', PUT: 'onRequestPut', PATCH: 'onRequestPatch', DELETE: 'onRequestDelete' };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // ---- ログイン ----
    if (pathname === '/login') {
      return (await isLoggedIn(request, env)) ? Response.redirect(new URL('/', request.url), 303) : loginPage(env);
    }
    if (pathname === '/api/login' && request.method === 'POST') {
      try { return await handleLogin(request, env); } catch (e) { return json({ error: 'サーバーエラー: ' + e.message }, 500); }
    }
    if (pathname === '/logout') return handleLogout();

    // 外部ツール (Claude など) 用: API_TOKEN を設定した場合は Bearer トークンでも API を利用可
    const auth = request.headers.get('authorization') || '';
    const bearerOk = !!env.API_TOKEN && auth === `Bearer ${env.API_TOKEN}` && pathname.startsWith('/api/');
    if (auth.startsWith('Bearer ') && !bearerOk) return json({ error: 'トークンが正しくありません' }, 401);

    if (!bearerOk && !(await isLoggedIn(request, env))) {
      if (pathname.startsWith('/api/')) return json({ error: 'ログインしてください', login: true }, 401);
      return Response.redirect(new URL('/login', request.url), 303);
    }

    if (!pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      // ログインが必要なページはキャッシュさせない
      const h = new Headers(res.headers);
      h.set('cache-control', 'no-store');
      h.set('x-frame-options', 'DENY');
      return new Response(res.body, { status: res.status, headers: h });
    }

    for (const [re, mod] of ROUTES) {
      const m = pathname.match(re);
      if (!m) continue;
      const handler = mod[METHOD[request.method]];
      if (!handler) return json({ error: 'このメソッドは使えません' }, 405);
      try {
        await ensureSchema(env.DB);
        return await handler({ request, env, params: m.groups || {} });
      } catch (e) {
        return json({ error: 'サーバーエラー: ' + e.message }, 500);
      }
    }
    return json({ error: '見つかりません' }, 404);
  },
};
