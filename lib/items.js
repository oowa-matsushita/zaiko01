// 在庫アイテムの共通処理
export const FIELDS = [
  'name', 'model_no', 'category', 'condition_rank', 'quantity',
  'purchase_date', 'purchase_price', 'supplier', 'location', 'list_price',
  'status', 'sold_date', 'sold_price', 'fees', 'notes',
];
const INT_FIELDS = new Set(['quantity', 'purchase_price', 'list_price', 'sold_price', 'fees']);
export const STATUSES = ['in_stock', 'listed', 'sold'];

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// 入力を検証して保存用の値に変換する。partial=true なら指定項目のみ
export function clean(input, partial = false) {
  if (!input || typeof input !== 'object') throw new Error('JSONオブジェクトを送ってください');
  const out = {};
  for (const f of FIELDS) {
    if (!(f in input)) continue;
    let v = input[f];
    if (v === '' || v === undefined) v = null;
    if (v !== null && INT_FIELDS.has(f)) {
      const n = Number(String(v).replace(/[,円¥\s]/g, ''));
      if (!Number.isFinite(n)) throw new Error(`${f} は数値で入力してください`);
      v = Math.round(n);
    } else if (v !== null) {
      v = String(v).trim();
    }
    out[f] = v;
  }
  if (!partial || 'name' in out) {
    if (!out.name) throw new Error('品名は必須です');
  }
  if ('status' in out && out.status !== null && !STATUSES.includes(out.status)) {
    throw new Error(`status は ${STATUSES.join(' / ')} のいずれかです`);
  }
  for (const f of ['quantity', 'purchase_price', 'fees']) {
    if (f in out && out[f] === null) out[f] = f === 'quantity' ? 1 : 0;
  }
  if ('status' in out && out.status === null) out.status = 'in_stock';
  // 売却済みにしたのに販売日が無ければ今日を入れる
  if (out.status === 'sold' && !out.sold_date) out.sold_date = today();
  return out;
}

export function today() {
  // 日本時間の日付
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

// 利益 = 販売価格 - 買取価格 - 手数料
export const PROFIT_SQL =
  `CASE WHEN sold_price IS NULL THEN NULL ELSE sold_price - purchase_price - fees END`;
