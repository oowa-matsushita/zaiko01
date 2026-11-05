// API の保護
// - サイト全体は Cloudflare Access で保護する前提（ブラウザからのアクセス）
// - 環境変数 API_TOKEN を設定すると「Authorization: Bearer <API_TOKEN>」でもアクセス可能
//   （Claude など外部ツールからの連携用）
export async function onRequest({ request, env, next }) {
  const auth = request.headers.get('authorization') || '';
  if (env.API_TOKEN && auth === `Bearer ${env.API_TOKEN}`) return next();
  if (auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'トークンが正しくありません' }), {
      status: 401, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  try {
    return await next();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'サーバーエラー: ' + e.message }), {
      status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
