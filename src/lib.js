// 在庫アイテムの共通処理
// name = 車名
export const FIELDS = [
  'name', 'grade', 'first_reg', 'chassis_no', 'color', 'color_code', 'mileage', 'mileage_unit',
  'sales_points', 'has_warranty', 'has_manual',
  'own_company', 'own_date', 'venue', 'event_date', 'shipped_date', 'carrier', 'landing_price',
  'model_no', 'category', 'condition_rank', 'quantity',
  'purchase_date', 'purchase_price', 'supplier', 'location', 'list_price',
  'status', 'sold_date', 'sold_price', 'fees', 'notes',
];
const FIELD_LABELS = { mileage: '走行距離', landing_price: '着地予想', purchase_price: '買取金額', list_price: '予定価格', sold_price: '販売価格', fees: '手数料', quantity: '数量' };
const INT_FIELDS = new Set(['quantity', 'purchase_price', 'list_price', 'sold_price', 'fees', 'mileage', 'landing_price']);
const BOOL_FIELDS = new Set(['has_warranty', 'has_manual']);
export const MILEAGE_UNITS = ['km', 'mile'];
export const VENUES = ['名古屋', '静岡', '廃車'];
export const CARRIERS = ['シンセイ①', 'シンセイ②', 'シンセイ③', 'シンセイ④', 'タカラ', '自社'];
// 以前の選択肢。すでに入っている車両はそのまま保存できるようにする
const OLD_CARRIERS = ['シンセイ', 'シンセイ1', 'シンセイ2', 'シンセイ3', 'シンセイ4'];
const DATE_FIELDS = new Set(['own_date', 'event_date', 'shipped_date', 'purchase_date', 'sold_date']);

// 後から追加した列。Worker が起動時に足りない列を自動で追加する
const ADDED_COLUMNS = {
  chassis_no: 'TEXT',
  color: 'TEXT',
  color_code: 'TEXT',
  mileage: 'INTEGER',
  mileage_unit: "TEXT NOT NULL DEFAULT 'km'",
  sales_points: 'TEXT',
  has_warranty: 'INTEGER NOT NULL DEFAULT 0',
  has_manual: 'INTEGER NOT NULL DEFAULT 0',
  own_date: 'TEXT',      // 自社名（日付）
  own_company: 'TEXT',   // 未使用（一時的に文字の自社名を入れていた列）
  venue: 'TEXT',         // 会場
  event_date: 'TEXT',    // 開催日
  shipped_date: 'TEXT',  // 出庫日
  first_reg: 'TEXT',     // 初度登録（例：平成24年06月）
  landing_price: 'INTEGER', // 着地予想（円）
  carrier: 'TEXT',       // 陸送会社
  grade: 'TEXT',         // グレード
};
let schemaReady = null;
export function ensureSchema(db) {
  schemaReady ??= (async () => {
    const { results } = await db.prepare('PRAGMA table_info(items)').all();
    const have = new Set(results.map((r) => r.name));
    const adds = Object.entries(ADDED_COLUMNS).filter(([c]) => !have.has(c));
    if (adds.length) {
      await db.batch(adds.map(([c, t]) => db.prepare(`ALTER TABLE items ADD COLUMN ${c} ${t}`)));
    }
    if (adds.some(([c]) => c === 'first_reg')) await moveImportMemo(db);
    // 陸送会社の名前変更：シンセイ1〜4 → シンセイ①〜④
    await db.batch(['①', '②', '③', '④'].map((c, i) =>
      db.prepare('UPDATE items SET carrier = ?1 WHERE carrier = ?2').bind(`シンセイ${c}`, `シンセイ${i + 1}`)));
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
// CSV取り込みで以前メモに入れていた「在庫No …／メーカー …／型式 …／初度 …／車検 …」を整理する。
// 初度は first_reg 列へ移し、それ以外の自動で入れた項目はメモから消す（1回だけ実行）
const MEMO_KEYS = ['在庫No', 'メーカー', '型式', '初度', '車検'];
async function moveImportMemo(db) {
  const { results } = await db.prepare("SELECT id, notes FROM items WHERE notes LIKE '在庫No %' OR notes LIKE '%初度 %'").all();
  const stmts = [];
  for (const r of results) {
    const parts = String(r.notes).split('／');
    let first = null;
    const rest = parts.filter((p) => {
      const key = MEMO_KEYS.find((k) => p.startsWith(k + ' '));
      if (key === '初度') first = p.slice(3).trim();
      return !key;
    });
    stmts.push(db.prepare('UPDATE items SET first_reg = COALESCE(first_reg, ?2), notes = ?3 WHERE id = ?1')
      .bind(r.id, first, rest.join('／') || null));
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}
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
    if (BOOL_FIELDS.has(f)) {
      v = v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'あり' ? 1 : 0;
    } else if (v !== null && INT_FIELDS.has(f)) {
      const half = String(v).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
      const n = Number(half.replace(/[,，円¥\s]|km|キロ|マイル|mile/gi, ''));
      if (!Number.isFinite(n) || n < 0) throw new Error(`${FIELD_LABELS[f] || f} は数字で入力してください`);
      v = Math.round(n);
    } else if (v !== null) {
      v = String(v).trim();
    }
    out[f] = v;
  }
  if (!partial || 'name' in out) {
    if (!out.name) throw new Error('車名は必須です');
  }
  if ('status' in out && out.status !== null && !STATUSES.includes(out.status)) {
    throw new Error(`status は ${STATUSES.join(' / ')} のいずれかです`);
  }
  for (const f of DATE_FIELDS) {
    if (f in out && out[f] !== null && !/^\d{4}-\d{2}-\d{2}$/.test(out[f])) {
      throw new Error(`${f} は YYYY-MM-DD 形式の日付で入力してください`);
    }
  }
  if ('venue' in out && out.venue !== null && !VENUES.includes(out.venue)) {
    throw new Error(`会場は ${VENUES.join(' / ')} のいずれかです`);
  }
  if ('carrier' in out && out.carrier !== null && !CARRIERS.includes(out.carrier) && !OLD_CARRIERS.includes(out.carrier)) {
    throw new Error(`陸送会社は ${CARRIERS.join(' / ')} のいずれかです`);
  }
  if ('mileage_unit' in out) {
    if (out.mileage_unit === null) out.mileage_unit = 'km';
    if (!MILEAGE_UNITS.includes(out.mileage_unit)) throw new Error('距離の単位は km か mile です');
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
