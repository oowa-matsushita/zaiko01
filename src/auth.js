// ID・パスワードによるログイン
// 必要なシークレット（Cloudflare の Worker → 設定 → 変数とシークレット）:
//   LOGIN_ID        ログインID
//   LOGIN_PASSWORD  パスワード（12文字以上推奨）
//   SESSION_SECRET  ログイン状態の署名用のランダムな長い文字列（32文字以上）
import { json } from './lib.js';

const COOKIE = 'zaiko_session';
const SESSION_DAYS = 30;
const LOCK_WINDOW_MS = 15 * 60e3; // 15分
const MAX_FAIL_PER_IP = 5;        // 同じIPから15分で5回失敗したらロック
const MAX_FAIL_TOTAL = 30;        // 全体で15分に30回失敗したらロック（総当たり対策）

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const authConfigured = (env) =>
  !!(env.LOGIN_ID && env.LOGIN_PASSWORD && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
// 文字列を一定時間で比較（長さや内容の推測を防ぐ）
async function safeEqual(secret, a, b) {
  return equalBytes(await hmac(secret, 'cmp:' + a), await hmac(secret, 'cmp:' + b));
}

async function makeSession(env) {
  const payload = b64url(enc.encode(JSON.stringify({ u: env.LOGIN_ID, exp: Date.now() + SESSION_DAYS * 864e5 })));
  return `${payload}.${b64url(await hmac(env.SESSION_SECRET, payload))}`;
}

export async function isLoggedIn(request, env) {
  if (!authConfigured(env)) return false;
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  try {
    if (!equalBytes(fromB64url(sig), await hmac(env.SESSION_SECRET, payload))) return false;
    const { u, exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    // ID を変えると今までのログインは無効になる
    return u === env.LOGIN_ID && exp > Date.now();
  } catch {
    return false;
  }
}

const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function ensureAttemptsTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, ts INTEGER NOT NULL)').run();
}

// POST /api/login  { id, password }
export async function handleLogin(request, env) {
  if (!authConfigured(env)) {
    return json({ error: 'ログインの設定が完了していません（LOGIN_ID / LOGIN_PASSWORD / SESSION_SECRET）' }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: '入力が正しくありません' }, 400); }
  const id = String(body.id ?? '');
  const password = String(body.password ?? '');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const since = Date.now() - LOCK_WINDOW_MS;

  await ensureAttemptsTable(env.DB);
  const [byIp, total] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ?1 AND ts > ?2').bind(ip, since),
    env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ts > ?1').bind(since),
  ]);
  if (byIp.results[0].n >= MAX_FAIL_PER_IP || total.results[0].n >= MAX_FAIL_TOTAL) {
    return json({ error: 'ログインの失敗が続いたため、15分間ロックしています。しばらくしてからお試しください' }, 429);
  }

  const okId = await safeEqual(env.SESSION_SECRET, id, env.LOGIN_ID);
  const okPw = await safeEqual(env.SESSION_SECRET, password, env.LOGIN_PASSWORD);
  if (!(okId && okPw)) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?1, ?2)').bind(ip, Date.now()),
      env.DB.prepare('DELETE FROM login_failures WHERE ts < ?1').bind(Date.now() - 864e5),
    ]);
    return json({ error: 'IDまたはパスワードが違います' }, 401);
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?1').bind(ip).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': cookieHeader(await makeSession(env), SESSION_DAYS * 86400),
    },
  });
}

export function handleLogout() {
  return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': cookieHeader('', 0) } });
}

export function loginPage(env) {
  const setupMsg = authConfigured(env) ? '' :
    '<p class="err">ログインの設定がまだ完了していません。Cloudflare で LOGIN_ID・LOGIN_PASSWORD・SESSION_SECRET を設定してください。</p>';
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>ログイン｜中古車 買取在庫</title>
<style>
:root{--bg:#fff;--card:#fff;--text:#1d2330;--muted:#6b7280;--line:#c9ced6;--accent:#2563eb;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e7eaf0;--muted:#9aa3b2;--line:#3a414d;--accent:#3b82f6;--danger:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);
font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
form{width:min(360px,100%);display:grid;gap:14px;padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
h1{font-size:1.2rem;margin:0 0 4px;text-align:center}label{display:grid;gap:4px;font-size:.9rem;color:var(--muted)}
input{font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
button{font:inherit;font-size:1rem;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}.err{color:var(--danger);margin:0;font-size:.9rem;min-height:1.2em}
</style></head><body>
<form id="f" autocomplete="on">
  <h1>中古車 買取在庫</h1>
  ${setupMsg}
  <label>ID<input name="id" autocomplete="username" autocapitalize="none" required></label>
  <label>パスワード<input name="password" type="password" autocomplete="current-password" required></label>
  <p class="err" id="e" role="alert"></p>
  <button id="b">ログイン</button>
</form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');
f.addEventListener('submit',async(ev)=>{ev.preventDefault();e.textContent='';b.disabled=true;
  try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({id:f.id.value,password:f.password.value})});
    const d=await r.json().catch(()=>({}));
    if(r.ok){location.replace('/');return;}
    e.textContent=d.error||'ログインできませんでした';f.password.value='';f.password.focus();
  }catch{e.textContent='通信エラーです';}finally{b.disabled=false;}});
</script></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' },
  });
}
