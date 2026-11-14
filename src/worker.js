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
import { isLoggedIn, handleLogin, handleLogout, loginPage, tokenOk } from './auth.js';

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
  [/^\/api\/market-replace\/?$/, { onRequestPost: market.replaceAll }],
  [/^\/api\/market-summary\/?$/, { onRequestGet: market.summary }],
  [/^\/api\/backup\/?$/, { onRequestGet: backup.download }],
  [/^\/api\/restore\/?$/, { onRequestPost: backup.restore }],
  [/^\/api\/market\/(?<id>\d+)\/?$/, { onRequestGet: market.forItem }],
];
// トークン（Claude 用）で使える API
const TOKEN_PATHS = /^\/api\/market-(import|replace|summary|list|counts)\/?$/;
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

    // Claude 用：シークレット API_TOKEN（32文字以上）を「Authorization: Bearer ...」で送ると、
    // 相場データ（AA結果）の API だけ使える。在庫の変更・バックアップ・復元には使えない
    const auth = request.headers.get('authorization') || '';
    let bearerOk = false;
    if (auth.startsWith('Bearer ')) {
      if (!TOKEN_PATHS.test(pathname)) return json({ error: 'この操作はトークンでは使えません' }, 403);
      bearerOk = await tokenOk(env, auth.slice(7));
      if (!bearerOk) return json({ error: 'トークンが正しくありません' }, 401);
    }

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
