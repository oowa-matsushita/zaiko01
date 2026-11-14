// Claude 用：AA結果の形式の CSV を読んで、本番の相場データを「全部消して入れ直す」
//   node scripts/market-upload.mjs <CSVファイル> [--apply] [--url https://zaiko01.oowa-matsushita.workers.dev]
// --apply を付けないと確認だけ（dry_run）。トークンはクラウド環境のネットワーク秘密情報から自動で付く
// （ローカルで試すときは環境変数 API_TOKEN に入れる）
import fs from 'node:fs';
import { decodeCsv, parseCsv, isAuctionCsv, auctionToRows } from '../public/import-parse.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^https?:/.test(a));
const apply = args.includes('--apply');
const base = (args[args.indexOf('--url') + 1] && args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://zaiko01.oowa-matsushita.workers.dev').replace(/\/$/, '');
if (!file) { console.error('CSVファイルを指定してください'); process.exit(1); }

const rows = parseCsv(decodeCsv(fs.readFileSync(file)));
if (!isAuctionCsv(rows)) { console.error('AA結果の形式（セリ結果・応札額の列）ではありません'); process.exit(1); }
const data = auctionToRows(rows);
const headers = { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN || 'placeholder-replaced-by-proxy'}` };
const call = async (path, body) => {
  const r = await fetch(base + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${d.error || ''}`);
  return d;
};
console.log('いまのデータ', await call('/api/market-summary'));
console.log(apply ? '入れ替え' : '確認のみ', await call('/api/market-replace', { rows: data, dry_run: !apply }));
if (apply) console.log('入れ替え後', await call('/api/market-summary'));
