// CSV の読み込みと、在庫データへの変換（ブラウザとテストで共用）

// Shift-JIS / UTF-8 を自動判定して文字列にする
export function decodeCsv(buf) {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

// RFC4180 準拠の CSV パーサ（"" のエスケープ・セル内改行に対応）
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// 半角カナ→全角、全角英数→半角（「いすゞ」の「ゞ」などの踊り字はそのまま残す）
const nfkc = (s) => String(s ?? '').split(/([ゝゞヽヾ])/)
  .map((p) => (/^[ゝゞヽヾ]$/.test(p) ? p : p.normalize('NFKC'))).join('').replace(/\s+/g, ' ').trim();
export const normChassis = (s) => nfkc(s).toUpperCase().replace(/[ー－―‐−]/g, '-').replace(/[^A-Z0-9-]/g, '');
const UNKNOWN = new Set(['', 'フメイ', '不明', 'メイ', '-', '?']);

// 「白 No 070」「シルバー No 1C0」「黒 202」「パール」→ { color, color_code }
export function splitColor(raw) {
  let s = nfkc(raw).replace(/[★☆]/g, '').replace(/\s*他$/, '').replace(/\s*\?$/, '').trim();
  let color = s, code = '';
  const m = s.match(/^(.*?)\s*(?:No\.?|NO\.?|№)\s*(.*)$/i);
  if (m) { color = m[1]; code = m[2]; }
  else {
    const m2 = s.match(/^(.+?)\s+([A-Za-z0-9]{2,})$/);
    if (m2) { color = m2[1]; code = m2[2]; }
  }
  code = (code.split(' ')[0] || '').replace(/[?？]/g, '').toUpperCase();
  if (UNKNOWN.has(code) || !/^[A-Z0-9]+$/.test(code)) code = '';
  color = color.trim();
  if (UNKNOWN.has(color)) color = '';
  return { color, color_code: code };
}

// 見出し名 → 項目（列の順番が変わっても読めるように名前で探す）
const HEAD = {
  stock_no: ['在庫No', '在庫NO', '在庫番号'],
  maker: ['車名', 'メーカー'],
  model: ['愛称名', '車種', '車種名'],
  first_reg: ['初度', '初度登録'],
  inspection: ['満了日', '車検満了日', '車検'],
  color: ['色', 'カラー'],
  mileage: ['走行距離', '走行'],
  type: ['型式'],
  chassis: ['車台番号', '車体番号'],
  purchase: ['仕入金額', '買取金額', '仕入価格', '買取価格'],
  list: ['予定売価本体予定', '予定売価', '予定価格', '予定売価本体'],
};

export function csvToItems(rows) {
  if (rows.length < 2) throw new Error('データがありません');
  const head = rows[0].map((h) => nfkc(h));
  const idx = {};
  for (const [k, names] of Object.entries(HEAD)) idx[k] = head.findIndex((h) => names.includes(h));
  if (idx.chassis < 0) throw new Error('「車台番号」の列が見つかりません');
  if (idx.model < 0 && idx.maker < 0) throw new Error('「愛称名」または「車名」の列が見つかりません');
  const get = (r, k) => (idx[k] >= 0 ? nfkc(r[idx[k]]) : '');

  return rows.slice(1).map((r, i) => {
    const { color, color_code } = splitColor(get(r, 'color'));
    const km = Number(get(r, 'mileage').replace(/[^\d-]/g, ''));

    return {
      line: i + 2,
      name: get(r, 'model') || get(r, 'maker'),
      chassis_no: normChassis(get(r, 'chassis')),
      color,
      color_code,
      mileage: Number.isFinite(km) && km >= 0 && get(r, 'mileage') !== '' ? km : null,
      mileage_unit: 'km',
      first_reg: get(r, 'first_reg'),
      list_price: (() => { const v = Number(get(r, 'list').replace(/[^\d]/g, '')); return get(r, 'list') !== '' && Number.isFinite(v) && v > 0 ? v : null; })(),
      purchase_price: (() => { const v = Number(get(r, 'purchase').replace(/[^\d]/g, '')); return get(r, 'purchase') !== '' && Number.isFinite(v) ? v : null; })(),
    };
  });
}

// ---- 月初在庫（回転率用） ----
// 在庫No「Z26-0927-05」の 26-0927 を入庫日（2026-09-27）とみなす
export function inDateFromStockNo(no) {
  const m = String(no || '').match(/^[A-Za-z]*(\d{2})-(\d{2})(\d{2})-/);
  if (!m) return '';
  const iso = `20${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : '';
}

// 在庫一覧CSV → 月初在庫の行 { no, maker, name, reg, color, km, type, chassis, list, cost, in }
export function csvToSnapshot(rows) {
  if (rows.length < 2) throw new Error('データがありません');
  const head = rows[0].map((h) => nfkc(h));
  const find = (names) => head.findIndex((h) => names.includes(h));
  const idx = {
    no: find(HEAD.stock_no), maker: find(['車名', 'メーカー']), name: find(['愛称名', '車種', '車種名']),
    reg: find(HEAD.first_reg), color: find(HEAD.color), km: find(HEAD.mileage), type: find(HEAD.type),
    chassis: find(HEAD.chassis), list: find(HEAD.list), cost: find(HEAD.purchase),
  };
  if (idx.chassis < 0 && idx.no < 0) throw new Error('「車台番号」または「在庫No」の列が見つかりません');
  const get = (r, k) => (idx[k] >= 0 ? nfkc(r[idx[k]]) : '');
  const yen = (r, k) => { const s = get(r, k).replace(/[^\d]/g, ''); return s === '' ? null : Number(s); };
  return rows.slice(1).map((r) => {
    const no = get(r, 'no');
    const km = get(r, 'km').replace(/[^\d]/g, '');
    return {
      no, maker: get(r, 'maker'), name: get(r, 'name') || get(r, 'maker'), reg: get(r, 'reg'),
      color: get(r, 'color').replace(/[★☆]/g, '').trim(), km: km === '' ? null : Number(km), type: get(r, 'type'),
      chassis: normChassis(get(r, 'chassis')), list: yen(r, 'list'), cost: yen(r, 'cost'), in: inDateFromStockNo(no),
    };
  }).filter((r) => r.chassis || r.no);
}

// ファイル名の「202610」などから月（2026-10）を読み取る
export function ymFromFileName(name) {
  const m = String(name || '').match(/(20\d{2})[-_年.]?(0[1-9]|1[0-2])(?!\d)/);
  return m ? `${m[1]}-${m[2]}` : '';
}
