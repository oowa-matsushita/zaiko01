// Cloudflare Workers のエントリ。/api/* をここで処理し、それ以外は public/ の静的ファイルを返す
import * as items from './api/items.js';
import * as item from './api/item.js';
import * as stats from './api/stats.js';
import { json } from './lib.js';

const ROUTES = [
  [/^\/api\/items\/?$/, items],
  [/^\/api\/items\/(?<id>[^/]+)\/?$/, item],
  [/^\/api\/stats\/?$/, stats],
];
const METHOD = { GET: 'onRequestGet', POST: 'onRequestPost', PUT: 'onRequestPut', PATCH: 'onRequestPatch', DELETE: 'onRequestDelete' };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // 外部ツール (Claude など) 用: API_TOKEN を設定した場合は Bearer トークンでも利用可
    const auth = request.headers.get('authorization') || '';
    if (auth.startsWith('Bearer ') && !(env.API_TOKEN && auth === `Bearer ${env.API_TOKEN}`)) {
      return json({ error: 'トークンが正しくありません' }, 401);
    }

    for (const [re, mod] of ROUTES) {
      const m = pathname.match(re);
      if (!m) continue;
      const handler = mod[METHOD[request.method]];
      if (!handler) return json({ error: 'このメソッドは使えません' }, 405);
      try {
        return await handler({ request, env, params: m.groups || {} });
      } catch (e) {
        return json({ error: 'サーバーエラー: ' + e.message }, 500);
      }
    }
    return json({ error: '見つかりません' }, 404);
  },
};
