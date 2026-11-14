const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KM_PER_MILE = 1.609344;
const num = (n) => Number(n).toLocaleString('ja-JP');
const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');
// 予定価格は税抜で保存し、表示・入力は税込（×1.1）で行う
const TAX = 1.1;
const withTax = (v) => (v ? Math.round(v * TAX) : v);
const fromTaxInput = (s) => {
  const t = String(s ?? '').normalize('NFKC').replace(/[,，円¥\s]/g, '');
  if (t === '') return '';
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n / TAX) : s; // 数字でなければそのまま送ってサーバーでエラー表示
};
const fmtMileage = (it) => it.mileage == null ? null
  : it.mileage_unit === 'mile'
    ? `${num(it.mileage)}マイル（約${num(Math.round(it.mileage * KM_PER_MILE))}km）`
    : `${num(it.mileage)}km`;

// D1 の datetime('now') は UTC なので日本時間の日付にする
const jstDate = (t) => t ? new Date(Date.parse(t.replace(' ', 'T') + 'Z') + 9 * 3600e3).toISOString().slice(0, 10) : '';
// 2026-11-05 → 11月5日（今年以外は年も付ける）
const mdDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  const thisYear = new Date(Date.now() + 9 * 3600e3).getUTCFullYear();
  return `${y !== thisYear ? y + '年' : ''}${m}月${day}日`;
};
const state = { q: '', event_date: '', shipped_date: '', beforeShip: true, own: '', carrier: '', items: [] };
try {
  // 出庫前のみ表示は既定でオン（自分でオフにした場合だけオフのまま）
  state.beforeShip = localStorage.getItem('zaiko-before-ship-v2') !== '0';
  state.own = localStorage.getItem('zaiko-own') || '';
  state.carrier = localStorage.getItem('zaiko-carrier') || '';
} catch { /* 既定はオフ */ }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { location.href = '/login'; throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

// ---- 開催日・出庫日のプルダウン ----
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}(${WD[dow(iso)]})`; };

// 会場と開催曜日：名古屋＝金曜、静岡＝土曜
const VENUE_DAY = { 5: '名古屋', 6: '静岡' };
const VENUE_WEEKDAY = { 名古屋: 5, 静岡: 6 };
const VENUE_CLASS = { 名古屋: 'nagoya', 静岡: 'shizuoka', 廃車: 'haisha' };
// 開催日：今日から4週間の金曜・土曜
function eventDates() {
  const t = jstToday(), out = [];
  for (let i = 0; i < 28; i++) { const d = addDays(t, i); if (dow(d) === 5 || dow(d) === 6) out.push(d); }
  return out;
}
// 出庫日：今日から7日分
// 出庫日：今日から7日分 ＋ それより先で出庫予定のある日
function shippedDates(counts = {}) {
  const t = jstToday();
  const week = Array.from({ length: 7 }, (_, i) => addDays(t, i));
  const later = Object.keys(counts).filter((d) => d > week[6] && counts[d] > 0);
  return [...week, ...later].sort();
}

// 開催日（金・土）と出庫日（7日分）を、同じ日付が上下にそろう表にする。
// 列はどちらかに枠がある日付だけ。該当しない側は空きマス
function renderDateGrid(counts) {
  const ev = eventDates(), sh = shippedDates(counts.shipped_date);
  const extra = [state.event_date, state.shipped_date].filter((d) => d && !ev.includes(d) && !sh.includes(d));
  const cols = [...new Set([...ev, ...sh, ...extra])].sort();
  const box = (field, d) => {
    const n = counts[field][d] || 0;
    // 開催日：金曜は名古屋、土曜は静岡の色を付ける
    const venue = field === 'event_date' ? VENUE_DAY[dow(d)] : null;
    const cls = [n ? '' : 'zero', dow(d) === 6 ? 'sat' : dow(d) === 0 ? 'sun' : '', venue ? `v-${VENUE_CLASS[venue]}` : ''].join(' ');
    return `<button type="button" class="date-box ${cls}" data-field="${field}" data-date="${d}" aria-pressed="${state[field] === d}">
      <span class="d">${shortDate(d)}</span><span class="n">${n}<small>台</small></span>${venue ? `<span class="vtag">${venue}</span>` : ''}</button>`;
  };
  // 出庫日の枠の中に、その日の陸送会社ボタン（例：シンセイ① 2台）を並べる
  const carrierOrder = (c) => { const i = CARRIERS.indexOf(c); return i < 0 ? 99 : i; };
  const shipCell = (d) => {
    const cs = Object.entries(counts.shipped_carriers?.[d] || {}).sort((a, b) => carrierOrder(a[0]) - carrierOrder(b[0]));
    const chips = cs.map(([c, n]) => `<button type="button" class="carrier-chip" data-ship="${d}" data-carrier="${esc(c)}"
        aria-pressed="${state.shipped_date === d && state.carrier === c}">${esc(c)} <b>${n}台</b></button>`).join('');
    return `<div class="ship-cell">${box('shipped_date', d)}${chips ? `<div class="ship-carriers">${chips}</div>` : ''}</div>`;
  };
  const row = (field, label, list) =>
    `<span class="df-label">${label}</span>` +
    `<button type="button" class="date-box all" data-field="${field}" data-date="" aria-pressed="${!state[field]}"><span class="n">すべて</span></button>` +
    cols.map((d) => (list.includes(d) || state[field] === d
      ? (field === 'shipped_date' ? shipCell(d) : box(field, d))
      : '<span class="date-empty"></span>')).join('');
  const g = $('#f-dates');
  g.style.gridTemplateColumns = `3.5em minmax(58px, 1fr) repeat(${cols.length}, minmax(64px, 1fr))`;
  requestAnimationFrame(updateScrollHints);
  g.innerHTML = row('event_date', '開催日', ev) + row('shipped_date', '出庫日', sh);
}

async function loadDateCounts() {
  try {
    renderDateGrid(await api('/api/date-counts'));
  } catch { /* 台数が取れなくても一覧は表示する */ }
}

// 枠をクリックで絞り込み（選択中の枠をもう一度押すと解除）
$('#f-dates').addEventListener('click', (e) => {
  // 陸送会社ボタン：その出庫日・その陸送会社に絞り込む（もう一度押すと陸送会社だけ解除）
  const chip = e.target.closest('.carrier-chip');
  if (chip) {
    const same = state.shipped_date === chip.dataset.ship && state.carrier === chip.dataset.carrier;
    state.shipped_date = chip.dataset.ship;
    setCarrier(same ? '' : chip.dataset.carrier);
    load();
    return;
  }
  const b = e.target.closest('.date-box');
  if (!b) return;
  const field = b.dataset.field;
  state[field] = state[field] === b.dataset.date ? '' : b.dataset.date;
  load();
});

async function load() {
  const p = new URLSearchParams({ sort: 'created_desc', limit: '1000' });
  if (state.q) p.set('q', state.q);
  if (state.event_date) p.set('event_date', state.event_date);
  if (state.shipped_date) p.set('shipped_date', state.shipped_date);
  if (state.beforeShip) p.set('before_ship', jstToday());
  if (state.own) p.set('own', state.own);
  if (state.carrier) p.set('carrier', state.carrier);
  loadDateCounts();
  try {
    const data = await api('/api/items?' + p);
    state.items = data.items;
    render(data);
  } catch (e) {
    setBody(`<tbody><tr><td class="empty" colspan="${colCount()}">読み込みに失敗しました：${esc(e.message)}</td></tr></tbody>`);
  }
}

// 表の列: [キー, 見出し, 種類]
const COLS = [
  ['id', 'No.', 'rowno'],
  ['first_reg', '初度登録'],
  ['name', '車名'],
  ['grade', 'グレード'],
  ['chassis_no', '車台番号'],
  ['color', '色'],
  ['color_code', 'カラーコード'],
  ['mileage', '走行距離', 'num'],
  ['purchase_price', '買取金額', 'num'],
  ['landing_price', '着地予想', 'num'],
  ['list_price', '予定価格', 'num'],
  ['own_date', '自社名', 'date'],
  ['venue', '会場', 'center'],
  ['event_date', '開催日', 'date'],
  ['shipped_date', '出庫日', 'date'],
  ['carrier', '陸送会社', 'center'],
  ['notes', 'メモ', 'wrap'],
  ['created_at', '登録日'],
];
const COL = Object.fromEntries(COLS.map(([k, label, cls]) => [k, { label, cls }]));
COL.blank = { label: '', cls: 'blank' };
// 表示レイアウト。2段は縦型モニター向けに1台を2行で表示（No. は2行分）
const LAYOUTS = {
  1: [COLS.map((c) => c[0])],
  2: [
    ['id', 'first_reg', 'name', 'grade', 'chassis_no', 'color', 'color_code', 'mileage', 'purchase_price', 'landing_price', 'list_price'],
    ['blank', 'own_date', 'blank', 'venue', 'event_date', 'shipped_date', 'carrier', 'created_at', 'notes*2'],
  ],
};
// 表示は1段（横長）のみ
const layout = () => LAYOUTS[1];
const sortState = { key: 'id', dir: -1 };
// 並び替え用の値（マイルは km に換算して比較）
// 和暦（昭和・平成・令和）の年月を並び替え用の数値に（例：平成24年06月 → 201206）
const ERA = { 昭和: 1925, 平成: 1988, 令和: 2018 };
function warekiNum(s) {
  const m = String(s || '').match(/(昭和|平成|令和)\s*(\d+|元)\s*年?\s*(\d+)?/);
  if (m) return (ERA[m[1]] + (m[2] === '元' ? 1 : Number(m[2]))) * 100 + Number(m[3] || 0);
  const w = String(s || '').match(/(\d{4})\D*(\d{1,2})?/);
  return w ? Number(w[1]) * 100 + Number(w[2] || 0) : null;
}
// 表示用：平成24年06月 → H24/6、令和03年11月 → R3/11、昭和 → S（データはそのまま）
const ERA_ABBR = { 昭和: 'S', 平成: 'H', 令和: 'R' };
function shortWareki(s) {
  const m = String(s || '').match(/(昭和|平成|令和)\s*(\d+|元)\s*年?\s*(\d+)?/);
  if (!m) return s || '';
  const y = m[2] === '元' ? 1 : Number(m[2]);
  return `${ERA_ABBR[m[1]]}${y}${m[3] ? '/' + Number(m[3]) : ''}`;
}
// 色名を「白（ホワイト）」の形にそろえて表示する（保存されているデータはそのまま）
// 色の言葉が複数あるときは先に出てくるものを採用。「パール」は他の色の言葉がないときだけ白とみなす
const COLOR_GROUPS = [
  ['白（ホワイト）', ['白', 'ホワイト', 'ﾎﾜｲﾄ']],
  ['黒（ブラック）', ['黒', 'ブラック']],
  ['赤（レッド）', ['赤', 'レッド', 'ワイン', 'ボルドー']],
  ['青（ブルー）', ['青', 'ブルー', 'アオ']],
  ['紺（ネイビー）', ['紺', 'ネイビー']],
  ['銀（シルバー）', ['銀', 'シルバー']],
  ['灰（グレー）', ['灰', 'グレー', 'グレイ', 'ガンメタ']],
  ['緑（グリーン）', ['緑', 'グリーン', 'カーキ']],
  ['黄（イエロー）', ['黄', 'イエロー']],
  ['橙（オレンジ）', ['橙', 'オレンジ']],
  ['茶（ブラウン）', ['茶', 'ブラウン', 'ベージュ']],
  ['紫（パープル）', ['紫', 'ムラサキ', 'パープル']],
  ['桃（ピンク）', ['桃', 'ピンク']],
  ['金（ゴールド）', ['金', 'ゴールド']],
  ['アイボリー', ['アイボリー', 'クリーム']],
];
function colorLabel(raw) {
  const s = String(raw || '').normalize('NFKC');
  if (!s) return '';
  let best = null;
  for (const [label, words] of COLOR_GROUPS) {
    for (const w of words) {
      const i = s.indexOf(w);
      if (i >= 0 && (!best || i < best.i)) best = { i, label };
    }
  }
  if (best) return best.label;
  if (s.includes('パール')) return '白（ホワイト）';
  return s;
}
const sortVal = (it, k) => k === 'mileage'
  ? (it.mileage == null ? null : it.mileage_unit === 'mile' ? it.mileage * KM_PER_MILE : it.mileage)
  : k === 'first_reg' ? warekiNum(it.first_reg)
  : k === 'blank' ? null
  : it[k];
const cellHtml = (it, k) => {
  switch (k) {
    case 'first_reg': return esc(shortWareki(it.first_reg));
    case 'name': {
      const n = marketCount(it);
      return esc(it.name ?? '') + (n ? ` <span class="mk-badge" data-mk="${it.id}" title="実績を表示">実績${n}</span>` : '');
    }
    case 'color': return esc(colorLabel(it.color));
    case 'mileage': return esc(fmtMileage(it) ?? '');
    case 'list_price': return it[k] ? esc(yen(withTax(it[k]))) : '';
    case 'purchase_price': case 'landing_price': return it[k] ? esc(yen(it[k])) : '';
    case 'has_warranty': case 'has_manual': return it[k] ? '✓' : '';
    case 'created_at': return esc(mdDate(jstDate(it.created_at)));
    case 'own_date': case 'event_date': case 'shipped_date': return esc(mdDate(it[k]));
    default: return esc(it[k] ?? '');
  }
};

// 表に表示している順の車両一覧
function sortedItems() {
  const { key, dir } = sortState;
  return [...state.items].sort((a, b) => {
    const x = sortVal(a, key), y = sortVal(b, key);
    if (x == null || x === '') return 1;
    if (y == null || y === '') return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ja')) * dir;
  });
}

// レイアウトの 'notes*2' は2列分の幅（colspan）
const spec = (e) => { const [k, n] = e.split('*'); return { k, span: Number(n) || 1 }; };
const colspanAttr = (n) => (n > 1 ? ` colspan="${n}"` : '');

// 横スクロールしても左に固定する列（No.・初度登録・車名の3列）
const FREEZE = 3;
const fzClass = (r, i) => { const col = r === 0 ? i : i + 1; return col < FREEZE ? ` fz fz${col}` : ''; };

function renderHead() {
  const rows = layout();
  $('#tbl thead').innerHTML = rows.map((keys, r) => `<tr>${keys.map((e, i) => {
    const { k, span: cs } = spec(e);
    const { label, cls } = COL[k];
    const arrow = sortState.key === k ? (sortState.dir > 0 ? '▲' : '▼') : '';
    const span = (k === 'id' && rows.length > 1 ? ` rowspan="${rows.length}"` : '') + colspanAttr(cs);
    return `<th data-key="${k}"${span} class="${cls === 'center' ? cls : ''}${r > 0 ? ' sub' : ''}${rows.length > 1 || r === 0 ? fzClass(r, i) : ''}">${label}<span class="arrow">${arrow}</span></th>`;
  }).join('')}</tr>`).join('');
  updateStickyHead();
}

// 会場の色：会場の欄と、会場に合った曜日の開催日の欄に色を付ける（曜日が合わないときは警告色）
function venueCellClass(it, k) {
  const v = VENUE_CLASS[it.venue];
  if (!v) return '';
  if (k === 'venue') return `v-${v}`;
  if (k === 'event_date' && it.event_date && VENUE_WEEKDAY[it.venue] != null) {
    return dow(it.event_date) === VENUE_WEEKDAY[it.venue] ? `v-${v}` : 'v-mismatch';
  }
  return '';
}

function rowHtml(it) {
  const rows = layout();
  return rows.map((keys, r) => `<tr data-id="${it.id}"${r === rows.length - 1 ? ' class="last"' : ''}>${keys.map((e, i) => {
    const { k, span } = spec(e);
    if (k === 'id') {
      return `<td class="rowno fz fz0"${rows.length > 1 ? ` rowspan="${rows.length}"` : ''}><button class="edit-btn" data-open="${it.id}" title="フォームで編集" aria-label="フォームで編集">✎</button>${it.id}</td>`;
    }
    const cls = [COL[k].cls, EDITABLE.has(k) ? 'editable' : '', venueCellClass(it, k)].filter(Boolean).join(' ') + fzClass(r, i);
    return `<td class="${cls}" data-key="${k}"${k === 'color' && it.color ? ` title="${esc(it.color)}"` : ''}${colspanAttr(span)}>${cellHtml(it, k)}</td>`;
  }).join('')}</tr>`).join('');
}

function setBody(html) {
  document.querySelectorAll('#tbl tbody').forEach((t) => t.remove());
  $('#tbl').insertAdjacentHTML('beforeend', html);
}
const colCount = () => Math.max(...layout().map((r) => r.reduce((n, e) => n + spec(e).span, 0)));

function render({ total }) {
  $('#count').textContent = `${total} 台`;
  const qr = $('#q-result');
  qr.hidden = !state.q;
  if (state.q) {
    qr.textContent = total ? `「${state.q}」で ${total} 台見つかりました` : `「${state.q}」に当てはまる車両はありません`;
    qr.classList.toggle('none', !total);
  }
  for (const [k, id] of [['color', '#dl-color']]) {
    const vals = [...new Set(state.items.map((i) => i[k]).filter(Boolean))].sort();
    $(id).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  }
  renderHead();
  if (!state.items.length) {
    setBody(`<tbody><tr><td class="empty" colspan="${colCount()}">${state.q || state.event_date || state.shipped_date || state.beforeShip || state.own || state.carrier ? '該当する車両がありません' : 'まだ登録がありません。「＋ 買取登録」から追加してください'}</td></tr></tbody>`);
    return;
  }
  const rows = sortedItems();
  // 1台ごとに tbody を分けて、2段表示でも1台単位で色分け・ハイライトする
  setBody(rows.map((it) => `<tbody class="vehicle${it.id === selectedId ? ' selected' : ''}" data-vid="${it.id}">${rowHtml(it)}</tbody>`).join(''));
  fitTable();
}

$('#tbl thead').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const k = th.dataset.key;
  if (k === 'blank') return;
  sortState.dir = sortState.key === k ? -sortState.dir : 1;
  sortState.key = k;
  render({ total: state.items.length });
});

// ---- フォーム ----
const dlg = $('#dlg');
const form = $('#form');

function openForm(item) {
  form.reset();
  $('#form-error').textContent = '';
  $('#dlg-title').textContent = item ? '車両を編集' : '買取登録';
  $('#btn-delete').hidden = !item;
  const data = item || { mileage_unit: 'km' };
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    if (el.type === 'checkbox') el.checked = !!data[el.name];
    else {
      // 選択肢にない以前の値（例：シンセイ）は一時的に選択肢へ加えて消えないようにする
      el.querySelectorAll?.('option.old').forEach((o) => o.remove());
      if (el.tagName === 'SELECT' && data[el.name] && ![...el.options].some((o) => o.value === data[el.name])) {
        el.add(Object.assign(document.createElement('option'), { value: data[el.name], textContent: data[el.name], className: 'old' }));
      }
      el.value = (el.name === 'list_price' ? withTax(data[el.name]) : data[el.name]) ?? '';
    }
  }
  if (!item) form.elements.id.value = '';
  updateMileage();
  dlg.showModal();
  if (!item) form.elements.name.focus();
}

function updateMileage() {
  const mv = form.elements.mileage.value;
  $('.mileage-conv').textContent = mv !== '' && form.elements.mileage_unit.value === 'mile'
    ? `約 ${num(Math.round(Number(mv.replace(/[,，\s]/g, "")) * KM_PER_MILE))} km` : "";
}
form.addEventListener('input', updateMileage);
form.addEventListener('change', updateMileage);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of form.elements) {
    if (!el.name || el.name === 'id') continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.name === 'list_price' ? fromTaxInput(el.value) : el.value;
  }
  const id = form.elements.id.value;
  try {
    await api(id ? `/api/items/${id}` : '/api/items', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    dlg.close();
    load();
  } catch (err) {
    $('#form-error').textContent = err.message;
  }
});

$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-delete').addEventListener('click', async () => {
  const id = form.elements.id.value;
  if (!id || !confirm('この車両を削除しますか？')) return;
  try { await api(`/api/items/${id}`, { method: 'DELETE' }); dlg.close(); load(); }
  catch (err) { $('#form-error').textContent = err.message; }
});
$('#btn-add').addEventListener('click', () => openForm(null));

// 日付欄はクリックでカレンダーを開く
function openPicker(input) {
  try { input.showPicker(); } catch { /* 未対応ブラウザは標準の動作 */ }
}
document.addEventListener('click', (e) => {
  if (e.target.matches?.('input[type=date]')) openPicker(e.target);
});

// ---- 一覧での直接編集（ダブルクリック／ダブルタップ） ----
const EDITABLE = new Set(['first_reg', 'name', 'grade', 'chassis_no', 'color', 'color_code', 'mileage', 'own_date', 'venue',
  'event_date', 'shipped_date', 'carrier', 'purchase_price', 'landing_price', 'list_price', 'has_warranty', 'has_manual', 'notes']);
const DATE_KEYS = new Set(['own_date', 'event_date', 'shipped_date']);
const VENUES = ['名古屋', '静岡', '廃車'];
const CARRIERS = ['シンセイ①', 'シンセイ②', 'シンセイ③', 'シンセイ④', 'タカラ', '自社'];
const SELECTS = { venue: VENUES, carrier: CARRIERS };
let editing = null; // { td, item, key }

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 2500);
}

async function saveField(item, patch) {
  try {
    const row = await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    Object.assign(item, row);
    toast('保存しました');
    if ('event_date' in patch || 'shipped_date' in patch) loadDateCounts();
  } catch (err) {
    toast(err.message, true);
  }
}

function finishEdit(save) {
  if (!editing) return;
  const { td, item, key, read } = editing;
  editing = null;
  const patch = save ? read() : null;
  const changed = patch && Object.keys(patch).some((k) => String(patch[k] ?? '') !== String(item[k] ?? ''));
  const done = changed ? saveField(item, patch) : Promise.resolve();
  done.then(() => {
    td.classList.remove('editing');
    td.innerHTML = cellHtml(item, key);
    // 会場・開催日を変えたら、両方の欄の色を付け直す
    if (key === 'venue' || key === 'event_date') {
      td.closest('tbody').querySelectorAll('td[data-key="venue"], td[data-key="event_date"]').forEach((c) => {
        c.classList.remove('v-nagoya', 'v-shizuoka', 'v-haisha', 'v-mismatch');
        const v = venueCellClass(item, c.dataset.key);
        if (v) c.classList.add(v);
      });
    }
  });
}

function startEdit(td) {
  if (editing) finishEdit(true);
  const key = td.dataset.key;
  const item = state.items.find((i) => i.id == td.parentElement.dataset.id);
  if (!item || !EDITABLE.has(key)) return;

  // 保証書・取説はダブルクリックで あり／なし を切り替え
  if (key === 'has_warranty' || key === 'has_manual') {
    saveField(item, { [key]: !item[key] }).then(() => { td.innerHTML = cellHtml(item, key); });
    return;
  }

  let html, read;
  if (key === 'mileage') {
    html = `<span class="with-unit"><input type="text" inputmode="numeric" autocomplete="off" value="${esc(item.mileage ?? '')}">
      <select><option value="km">km</option><option value="mile">マイル</option></select></span>`;
    read = () => ({ mileage: td.querySelector('input').value, mileage_unit: td.querySelector('select').value });
  } else if (SELECTS[key]) {
    const opts = item[key] && !SELECTS[key].includes(item[key]) ? [...SELECTS[key], item[key]] : SELECTS[key];
    html = `<select><option value="">未選択</option>${opts.map((v) => `<option>${esc(v)}</option>`).join('')}</select>`;
    read = () => ({ [key]: td.querySelector('select').value });
  } else if (key === 'notes') {
    html = `<textarea rows="3">${esc(item[key] ?? '')}</textarea>`;
    read = () => ({ [key]: td.querySelector('textarea').value });
  } else {
    const type = DATE_KEYS.has(key) ? 'date' : 'text';
    const numAttr = key === 'purchase_price' || key === 'landing_price' || key === 'list_price' ? ' inputmode="numeric" autocomplete="off"' : '';
    const shown = key === 'list_price' ? withTax(item[key]) : item[key];
    html = `<input type="${type}"${numAttr} value="${esc(shown ?? '')}"${key === 'color' ? ' list="dl-color"' : ''}>`;
    read = () => ({ [key]: key === 'list_price' ? fromTaxInput(td.querySelector('input').value) : td.querySelector('input').value });
  }
  td.classList.add('editing');
  td.innerHTML = html;
  if (key === 'mileage') td.querySelector('select').value = item.mileage_unit || 'km';
  if (SELECTS[key]) td.querySelector('select').value = item[key] || '';
  editing = { td, item, key, read };
  const first = td.querySelector('input, select, textarea');
  first.focus();
  if (first.type === 'date') openPicker(first);
  if (first.select && first.type === 'text') first.select();
  if (first.tagName === 'TEXTAREA') first.setSelectionRange(first.value.length, first.value.length); // メモは末尾から書き足せるように

  td.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    else if (e.key === 'Enter' && !e.isComposing && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) {
      e.preventDefault(); finishEdit(true);
    }
  });
  // セルの外に出たら保存（距離の数値→単位の移動では保存しない）
  td.addEventListener('focusout', (e) => {
    if (td.contains(e.relatedTarget)) return;
    setTimeout(() => { if (editing && editing.td === td) finishEdit(true); }, 0);
  });
  // 会場・日付は選んだ時点で保存
  if (SELECTS[key]) td.querySelector('select').addEventListener('change', () => finishEdit(true));
  if (DATE_KEYS.has(key)) td.querySelector('input').addEventListener('change', () => finishEdit(true));
}

// スマホでも確実に動くよう、2回のクリックの間隔で判定する
let lastTap = { td: null, t: 0 };
// クリックした車両の行に色を付けて、どれを見ているかわかるようにする
let selectedId = null;
function selectVehicle(tb) {
  document.querySelectorAll('#tbl tbody.selected').forEach((t) => t.classList.remove('selected'));
  tb.classList.add('selected');
  selectedId = Number(tb.dataset.vid);
}
$('#tbl').addEventListener('click', (e) => {
  if (e.target.closest('thead')) return;
  const tb = e.target.closest('tbody.vehicle');
  if (tb) selectVehicle(tb);
  const open = e.target.closest('[data-open]');
  if (open) { openForm(state.items.find((i) => i.id == open.dataset.open)); return; }
  const td = e.target.closest('td.editable');
  if (!td || td.classList.contains('editing')) return;
  const now = Date.now();
  if (lastTap.td === td && now - lastTap.t < 400) {
    lastTap = { td: null, t: 0 };
    startEdit(td);
  } else {
    lastTap = { td, t: now };
  }
});

let timer;
// 検索欄：入力中は枠を強調し、クリアボタンと「〇台見つかりました」を表示
function updateSearchUi() {
  const on = !!state.q;
  $('.search-box').classList.toggle('active', on);
  $('#q-clear').hidden = !$('#q').value;
}
$('#q').addEventListener('input', (e) => {
  clearTimeout(timer);
  $('#q-clear').hidden = !e.target.value;
  // 全角の英数字も半角にして探す（例：２１４５ → 2145）
  timer = setTimeout(() => { state.q = e.target.value.normalize('NFKC').trim(); updateSearchUi(); load(); }, 250);
});
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#q-clear').click(); });
$('#q-clear').addEventListener('click', () => {
  $('#q').value = '';
  state.q = '';
  updateSearchUi();
  load();
  $('#q').focus();
});


// ---- 依頼する（メール / PDF） ----
// 対象は表に表示中の車両（検索・日付の絞り込み・並び順をそのまま反映）
const REQ_FIELDS = [
  ['name', '車名'], ['chassis_no', '車台番号'], ['color', '色'], ['color_code', 'カラーコード'],
  ['mileage', '走行距離'], ['own_date', '自社名'], ['venue', '会場'], ['event_date', '開催日'], ['shipped_date', '出庫日'],
];
const DATE_FIELDS_REQ = new Set(['own_date', 'event_date', 'shipped_date']);
// 一覧印刷はすべての項目（No. は通し番号）
const LIST_FIELDS = COLS.filter(([k]) => k !== 'id').map(([k, l]) => [k, l]);
const WIDE_FIELDS = new Set(['notes']);
const CENTER_FIELDS = new Set(['venue', 'carrier', 'has_warranty', 'has_manual']);
const reqVal = (it, k) => k === 'mileage' ? (fmtMileage(it) ?? '')
  : k === 'first_reg' ? shortWareki(it.first_reg)
  : k === 'color' ? colorLabel(it.color)
  : k === 'has_warranty' || k === 'has_manual' ? (it[k] ? '✓' : '')
  : k === 'created_at' ? mdDate(jstDate(it.created_at))
  : k === 'list_price' ? (it[k] ? yen(withTax(it[k])) : '')
  : k === 'purchase_price' || k === 'landing_price' ? (it[k] ? yen(it[k]) : '')
  : DATE_FIELDS_REQ.has(k) ? (it[k] ? `${mdDate(it[k])}(${WD[dow(it[k])]})` : '')
  : (it[k] ?? '');
const todayLabel = () => { const t = jstToday(); return `${mdDate(t)}(${WD[dow(t)]})`; };
function filterLabel() {
  const f = [];
  if (state.event_date) f.push(`開催日 ${shortDate(state.event_date)}`);
  if (state.shipped_date) f.push(`出庫日 ${shortDate(state.shipped_date)}`);
  if (state.q) f.push(`検索「${state.q}」`);
  return f.join('／');
}

// 依頼文：開催日・会場・出庫日が同じ車両をまとめ、その条件を依頼日の下に書く。
// 車両は「車名　車台番号の右から4桁　色」だけのシンプルな形
const last4 = (c) => (c ? String(c).replace(/\s/g, '').slice(-4) : '－');
const reqDate = (d) => (d ? `${mdDate(d)}(${WD[dow(d)]})` : '未定');
function requestGroups(items) {
  const groups = new Map();
  for (const it of items) {
    const key = [it.event_date || '', it.venue || '', it.shipped_date || ''].join('|');
    if (!groups.has(key)) groups.set(key, { event_date: it.event_date, venue: it.venue, shipped_date: it.shipped_date, items: [] });
    groups.get(key).items.push(it);
  }
  return [...groups.values()];
}
function requestText(items) {
  const groups = requestGroups(items);
  const cond = (g) => [`開催日：${reqDate(g.event_date)}`, `会場：${g.venue || '未定'}`, `出庫日：${reqDate(g.shipped_date)}`];
  const list = (g) => g.items.map((it) => [it.name, last4(it.chassis_no), colorLabel(it.color)].filter(Boolean).join('　'));
  const lines = [`【依頼】${todayLabel()}`];
  if (groups.length === 1) {
    // すべて同じ条件 → 依頼日の下にまとめて書く
    lines.push(...cond(groups[0]), `全${items.length}台`, '', ...list(groups[0]));
  } else {
    lines.push(`全${items.length}台`);
    groups.forEach((g) => lines.push('', `■${cond(g).join('／')}（${g.items.length}台）`, ...list(g)));
  }
  return lines.join('\n') + '\n\nよろしくお願いいたします。';
}

const POPUP_STYLE = `body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:16px;color:#1d2330;background:#fff}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #c9ced6;background:#fff;cursor:pointer}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}`;

function openMailWindow(items) {
  const text = requestText(items);
  const w = window.open('', '_blank', 'width=560,height=760');
  if (!w) { toast('ポップアップがブロックされました。ブラウザの設定で許可してください', true); return; }
  w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>依頼文（${items.length}台）</title><style>${POPUP_STYLE}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
textarea{width:100%;box-sizing:border-box;height:calc(100vh - 90px);font:inherit;font-size:15px;line-height:1.6;padding:10px;border:1px solid #c9ced6;border-radius:8px}
#msg{color:#15803d}</style></head><body>
<div class="bar"><button class="primary" id="copy">コピーする</button><a id="mail" href="#"><button type="button">メールアプリで開く</button></a><span id="msg"></span></div>
<textarea id="t"></textarea></body></html>`);
  w.document.close();
  const ta = w.document.getElementById('t');
  ta.value = text;
  const subject = `【依頼】${todayLabel()} ${items.length}台`;
  w.document.getElementById('mail').href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  w.document.getElementById('copy').addEventListener('click', async () => {
    const msg = w.document.getElementById('msg');
    try {
      await w.navigator.clipboard.writeText(ta.value);
    } catch {
      ta.select(); w.document.execCommand('copy');
    }
    msg.textContent = 'コピーしました。メールやLINEに貼り付けてください';
  });
  ta.focus();
}

function openPdfWindow(items, fields = REQ_FIELDS, title = '依頼一覧') {
  const w = window.open('', '_blank', 'width=1000,height=760');
  if (!w) { toast('ポップアップがブロックされました。ブラウザの設定で許可してください', true); return; }
  const fl = filterLabel();
  const cls = (k) => k === 'mileage' ? ' class="r"' : WIDE_FIELDS.has(k) ? ' class="w"' : CENTER_FIELDS.has(k) ? ' class="c"' : '';
  const rows = items.map((it, i) => `<tr><td class="n">${i + 1}</td>${fields.map(([k]) => `<td${cls(k)}>${esc(reqVal(it, k))}</td>`).join('')}</tr>`).join('');
  w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${title}_${jstToday()}</title><style>${POPUP_STYLE}
@page{size:A4 landscape;margin:12mm}
h1{font-size:18px;margin:0 0 4px}.sub{font-size:12px;color:#444;margin:0 0 10px}
table{border-collapse:collapse;width:100%;font-size:11px}
th,td{border:1px solid #888;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#eef0f3}td.n{text-align:right;width:2em}td.r{text-align:right;white-space:nowrap}th,td{white-space:nowrap}td.w{white-space:normal;min-width:10em}.c{text-align:center}
tr{break-inside:avoid}thead{display:table-header-group}
.bar{margin-bottom:12px;display:flex;gap:8px;align-items:center}
@media print{.bar{display:none}body{padding:0}}</style></head><body>
<div class="bar"><button class="primary" onclick="print()">印刷 / PDFで保存</button><span style="font-size:13px;color:#555">印刷画面で「送信先：PDFに保存」を選ぶとPDFになります</span></div>
<h1>${title}</h1>
<p class="sub">${esc(todayLabel())}　全${items.length}台${fl ? '　対象：' + esc(fl) : ''}</p>
<table><thead><tr><th>No.</th>${fields.map(([k, l]) => `<th${CENTER_FIELDS.has(k) ? ' class="c"' : ''}>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

const reqMenu = $('#req-menu');
$('#btn-request').addEventListener('click', (e) => {
  e.stopPropagation();
  reqMenu.hidden = !reqMenu.hidden;
});
document.addEventListener('click', () => { reqMenu.hidden = true; });
reqMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-req]');
  if (!b) return;
  reqMenu.hidden = true;
  const items = sortedItems();
  if (!items.length) { toast('表に車両がありません', true); return; }
  if (b.dataset.req === 'mail') openMailWindow(items);
  else openPdfWindow(items);
});

// ---- 音声入力（セールスポイント） ----
// ブラウザ内蔵の音声認識（Chrome / Android、iPhone の Safari などで利用可）
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recBtn = null;

function stopVoice() {
  if (rec) { try { rec.stop(); } catch { /* 停止済み */ } }
}

function startVoice(btn) {
  const ta = document.getElementById(btn.dataset.target);
  const status = btn.closest('.field-voice').querySelector('.voice-status');
  rec = new SpeechRec();
  rec.lang = 'ja-JP';
  rec.interimResults = true;
  rec.continuous = true;
  recBtn = btn;
  let base = ta.value;

  rec.onstart = () => {
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '■ 停止';
    status.textContent = '聞き取り中…話し終わったら「停止」を押してください';
  };
  rec.onresult = (e) => {
    let finalText = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    if (finalText) {
      const sep = base && !/[、。\s]$/.test(base) ? '、' : '';
      base = base + sep + finalText.trim();
      ta.value = base;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    status.innerHTML = interim ? `<span class="interim">${esc(interim)}</span>` : '聞き取り中…';
  };
  rec.onerror = (e) => {
    const msg = {
      'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください',
      'service-not-allowed': 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください',
      'no-speech': '音声が聞き取れませんでした。もう一度お試しください',
      'audio-capture': 'マイクが見つかりません',
      'network': '通信エラーで音声認識できませんでした',
    }[e.error] || `音声入力エラー（${e.error}）`;
    status.textContent = msg;
  };
  rec.onend = () => {
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '🎤 音声入力';
    if (status.textContent.startsWith('聞き取り中') || status.querySelector('.interim')) status.textContent = '';
    rec = null; recBtn = null;
  };
  try { rec.start(); } catch (err) { status.textContent = '音声入力を開始できませんでした'; }
}

document.querySelectorAll('.mic').forEach((btn) => {
  if (!SpeechRec) {
    btn.addEventListener('click', () => {
      btn.closest('.field-voice').querySelector('.voice-status').textContent =
        'このブラウザは音声入力に対応していません。キーボードのマイクボタンをお使いください';
    });
    return;
  }
  btn.addEventListener('click', () => {
    if (rec && recBtn === btn) stopVoice(); else { stopVoice(); startVoice(btn); }
  });
});
// フォームを閉じたら音声入力も止める
dlg.addEventListener('close', () => {
  stopVoice();
  document.querySelectorAll('.voice-status').forEach((s) => { s.textContent = ''; });
});

// ---- コーションプレート撮影 → 車台番号・カラーコードを自動入力 ----
// 写真は保存せず、読み取りにだけ使う
async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.85);
}

function resetPlateScan() {
  $('.scan-result').hidden = true;
  $('#plate-status').textContent = '';
  $('#plate-file').value = '';
  form.querySelectorAll('input.filled').forEach((el) => el.classList.remove('filled'));
}
dlg.addEventListener('close', resetPlateScan);

$('#plate-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#plate-status');
  form.querySelectorAll('input.filled').forEach((el) => el.classList.remove('filled'));
  $('.scan-result').hidden = false;
  status.className = '';
  status.textContent = '読み取り中…（数秒かかります）';
  try {
    const image = await shrinkImage(file);
    $('#plate-preview').src = image;
    const r = await api('/api/ocr-plate', { method: 'POST', body: JSON.stringify({ image }) });
    const got = [];
    for (const [k, label] of [['chassis_no', '車台番号'], ['color_code', 'カラーコード']]) {
      if (r[k]) {
        form.elements[k].value = r[k];
        form.elements[k].classList.add('filled');
        got.push(`${label} ${r[k]}`);
      }
    }
    if (got.length) {
      status.className = 'ok';
      status.textContent = `読み取りました：${got.join('、')}。間違いがないか確認してください`;
    } else {
      status.className = 'ng';
      status.textContent = '読み取れませんでした。明るい場所で、プレートが画面いっぱいになるよう撮り直してください';
    }
  } catch (err) {
    status.className = 'ng';
    status.textContent = `読み取りに失敗しました：${err.message}`;
  } finally {
    e.target.value = '';
  }
});
form.addEventListener('input', (e) => e.target.classList?.remove('filled'));

$('#btn-print').addEventListener('click', () => {
  const items = sortedItems();
  if (!items.length) { toast('表に車両がありません', true); return; }
  openPdfWindow(items, LIST_FIELDS, '在庫一覧');
});

// ---- 出庫前のみ表示（出庫日が今日以降、または未定の車両だけ） ----
const beforeBtn = $('#btn-before-ship');
const updateBeforeBtn = () => beforeBtn.setAttribute('aria-pressed', String(state.beforeShip));
updateBeforeBtn();
beforeBtn.addEventListener('click', () => {
  state.beforeShip = !state.beforeShip;
  try { localStorage.setItem('zaiko-before-ship-v2', state.beforeShip ? '1' : '0'); } catch { /* 無視 */ }
  updateBeforeBtn();
  load();
});

// ---- 自社名済のみ／自社名待ち（自社名の日付が入っているか） ----
// どちらか一方だけ選べる。もう一度押すと解除
const ownBtns = document.querySelectorAll('[data-own]');
const updateOwnBtns = () => ownBtns.forEach((b) => b.setAttribute('aria-pressed', String(state.own === b.dataset.own)));
updateOwnBtns();
ownBtns.forEach((b) => b.addEventListener('click', () => {
  state.own = state.own === b.dataset.own ? '' : b.dataset.own;
  try { localStorage.setItem('zaiko-own', state.own); } catch { /* 無視 */ }
  updateOwnBtns();
  load();
}));

// ---- 画面幅に合わせて表の文字サイズを自動調整 ----
// 表が枠からはみ出す間は文字を少しずつ小さくする（下限 0.66rem）。それでも入らなければ横スクロール
const FONT_MAX = 1.0, FONT_MIN = 0.78;
function fitTable() {
  const wrap = $('.table-wrap'), tbl = $('#tbl');
  if (!wrap || !tbl) return;
  let size = FONT_MAX;
  tbl.style.fontSize = size + 'rem';
  while (tbl.scrollWidth > wrap.clientWidth + 1 && size > FONT_MIN) {
    size = Math.max(FONT_MIN, +(size - 0.03).toFixed(2));
    tbl.style.fontSize = size + 'rem';
  }
  updateStickyHead();
  updateScrollHints();
}
// 固定列の左位置を、実際の列幅から計算する
function updateFreeze() {
  const ths = [...document.querySelectorAll('#tbl thead tr:first-child th')].slice(0, FREEZE);
  let left = 0;
  ths.forEach((th, i) => {
    $('#tbl').style.setProperty(`--fz${i}`, left + 'px');
    left += th.getBoundingClientRect().width;
  });
}
// 2段目の見出しを1段目の下に固定する
function updateStickyHead() {
  updateFreeze();
  const first = $('#tbl thead tr');
  const h = first ? first.getBoundingClientRect().height : 0;
  document.querySelectorAll('#tbl thead th.sub').forEach((th) => { th.style.top = h + 'px'; });
}
// 横スクロールできるときだけ「← 横にスクロールできます →」を表示
function updateScrollHints() {
  for (const [box, id] of [[$('.table-wrap'), 'hint-table'], [$('.date-scroll'), 'hint-dates']]) {
    if (!box) continue;
    let hint = document.getElementById(id);
    const over = box.scrollWidth > box.clientWidth + 1;
    if (over && !hint) {
      box.insertAdjacentHTML('afterend', `<p class="scroll-hint" id="${id}">← 横にスクロールできます →</p>`);
    } else if (!over && hint) hint.remove();
  }
}
let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTable, 150); });

// ---- 陸送会社で絞り込み ----
const carrierSel = $('#f-carrier');
carrierSel.value = state.carrier;
carrierSel.classList.toggle('active', !!state.carrier);
function setCarrier(v) {
  state.carrier = v;
  carrierSel.value = v;
  carrierSel.classList.toggle('active', !!v);
  try { localStorage.setItem('zaiko-carrier', v); } catch { /* 無視 */ }
}
carrierSel.addEventListener('change', () => { setCarrier(carrierSel.value); load(); });

// ---- 「データをアップロード」の下に最終取り込み日時 ----
function showLastImport() {
  api('/api/import').then(({ last_import: li }) => {
    if (!li) return;
    const t = new Date(li.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    $('#last-import').textContent = `最終取込 ${t}`;
    $('#last-import').title = `追加 ${li.added} 台・更新 ${li.updated} 台${li.file ? '（' + li.file + '）' : ''}`;
  }).catch(() => {});
}
showLastImport();

// ---- 実績（過去のオークション結果）をマウスオーバーで表示 ----
let marketTypes = {};
const marketCache = new Map();
const chassisType = (c) => { const s = String(c || '').normalize('NFKC').toUpperCase().replace(/\s/g, ''); const i = s.indexOf('-'); return i > 0 ? s.slice(0, i) : ''; };
function marketCount(it) {
  const t = chassisType(it.chassis_no);
  if (!t) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(marketTypes)) if (k.startsWith(t)) n += v;
  return n;
}
async function loadMarketCounts() {
  try { marketTypes = (await api('/api/market-counts')).types || {}; } catch { marketTypes = {}; }
}

const man = (k) => (k == null ? '' : '¥' + (k * 1000).toLocaleString('ja-JP'));
// 列：[キー, 見出し, 表示, 並べ替えの値, セルのクラス]。全部の行で空の列は出さない（画面に収めるため）
const MK_COLS = [
  ['date', '開催日', (r) => esc(String(r.auction_date || '').slice(2).replaceAll('-', '/')), (r) => r.auction_date || '', ''],
  ['venue', '会場', (r) => esc(r.venue || ''), (r) => r.venue || '', ''],
  ['year', '年式', (r) => esc(r.year || ''), (r) => r.west_year, ''],
  ['name', '車種', (r) => esc(r.model_name || ''), (r) => r.model_name || '', 'w'],
  ['grade', 'グレード', (r) => esc(r.grade || ''), (r) => r.grade || '', 'w'],
  ['km', '走行', (r) => (r.mileage_k != null ? r.mileage_k + '千km' : ''), (r) => r.mileage_k, 'r'],
  ['color', '色', (r) => esc(r.color || ''), (r) => r.color || '', 'w'],
  ['score', '評価', (r) => esc(r.score || ''), (r) => r.score || '', 'c'],
  ['result', '結果', (r) => esc(r.result || ''), (r) => r.result || '', ''],
  ['price', '金額', (r) => man(r.price_k), (r) => r.price_k, 'r b'],
];
// 並べ替えの状態（表ごと）。まだ見出しを押していない表は、もとの順（似ている順）のまま
let mkSort = { own: null, sim: null };
let mkCur = null; // 表示中の { it, d }
function sortedRows(list, sort) {
  if (!sort) return list;
  const col = MK_COLS.find((c) => c[0] === sort.key);
  if (!col) return list;
  const val = col[3], dir = sort.dir === 'desc' ? -1 : 1;
  // 空の値は昇順・降順どちらでも最後に置く
  return [...list].sort((x, y) => {
    const a = val(x), b = val(y), ea = a == null || a === '', eb = b == null || b === '';
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'ja')) * dir;
  });
}
function marketHtml(it, d) {
  if (!d.own.length && !d.similar.length) return `<p class="mk-none">型式 ${esc(d.type)} の実績データはありません</p>`;
  const all = [...d.own, ...d.similar];
  const cols = MK_COLS.filter((c) => all.some((r) => c[2](r) !== ''));
  const row = (r) => `<tr class="${/落札/.test(r.result || '') ? '' : 'mk-unsold'}">${cols.map((c) => `<td class="${c[4]}">${c[2](r)}</td>`).join('')}</tr>`;
  const table = (t, list, cls) => {
    const sort = mkSort[t];
    const head = `<tr>${cols.map((c) => {
      const on = sort?.key === c[0];
      return `<th class="mk-sort" data-t="${t}" data-k="${c[0]}" title="押すと並べ替え" aria-sort="${on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}">${c[1]}${on ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`;
    }).join('')}</tr>`;
    return `<table class="mk-tbl ${cls}">${head}${sortedRows(list, sort).map(row).join('')}</table>`;
  };
  return `<div class="mk-title">📈 実績　型式 <b>${esc(d.type)}</b></div>
    ${d.stat ? `<div class="mk-stat">似た車両の落札 <b>${d.stat.n}</b> 台：中央値 <b>${man(d.stat.median)}</b>・平均 <b>${man(d.stat.avg)}</b>（${man(d.stat.min)} 〜 ${man(d.stat.max)}）</div>` : ''}
    ${d.own.length ? `<div class="mk-sub">この車両の過去の出品</div>${table('own', d.own, 'own')}` : ''}
    ${d.similar.length ? `<div class="mk-sub">似た車両（年式・走行が近い順${d.similar_total > d.similar.length ? `／全 ${d.similar_total} 件中 ${d.similar.length} 件` : ''}）</div>${table('sim', d.similar, '')}` : ''}`;
}

const pop = document.createElement('div');
pop.className = 'mk-pop';
pop.hidden = true;
document.body.appendChild(pop);
let popTimer, popFor = null;
async function showMarket(anchor, id) {
  const it = state.items.find((i) => i.id == id);
  if (!it) return;
  if (popFor !== id) mkSort = { own: null, sim: null }; // 別の車両を開いたら並べ替えを戻す
  popFor = id;
  pop.innerHTML = '<p class="mk-none">読み込み中…</p>';
  pop.hidden = false;
  placePop(anchor);
  try {
    if (!marketCache.has(id)) marketCache.set(id, await api(`/api/market/${id}`));
    if (popFor !== id) return;
    mkCur = { it, d: marketCache.get(id) };
    pop.innerHTML = marketHtml(it, mkCur.d);
    placePop(anchor);
  } catch (e) {
    pop.innerHTML = `<p class="mk-none">実績を読み込めませんでした：${esc(e.message)}</p>`;
  }
}
function placePop(anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight, m = 8, gap = 6;
  const w = Math.min(760, vw - m * 2);
  pop.style.width = w + 'px';
  pop.style.left = Math.max(m, Math.min(r.left, vw - w - m)) + 'px';
  // 本来の高さを測ってから、下・上のうち収まる方（どちらも無理なら広い方）に出す
  pop.style.maxHeight = 'none';
  const h = pop.offsetHeight;
  const below = vh - r.bottom - gap - m, above = r.top - gap - m;
  let top, max;
  if (h <= below) { top = r.bottom + gap; max = below; }
  else if (h <= above) { top = r.top - gap - h; max = above; }
  else if (Math.max(below, above) >= 240) {
    if (below >= above) { top = r.bottom + gap; max = below; } else { max = above; top = m; }
  } else { top = m; max = vh - m * 2; } // 上下とも狭いときは画面全体を使う
  pop.style.maxHeight = max + 'px';
  pop.style.top = Math.max(m, top) + 'px';
}
// 見出しを押すと昇順→降順→昇順…と切り替わる（表ごと）
pop.addEventListener('click', (e) => {
  const th = e.target.closest('th.mk-sort');
  if (!th || !mkCur) return;
  e.stopPropagation(); // 表を作り直すと押した見出しが消え、「外をクリックした」と誤判定して閉じてしまうため
  const t = th.dataset.t, k = th.dataset.k, cur = mkSort[t];
  mkSort[t] = { key: k, dir: cur?.key === k && cur.dir === 'asc' ? 'desc' : 'asc' };
  const top = pop.scrollTop;
  pop.innerHTML = marketHtml(mkCur.it, mkCur.d);
  pop.scrollTop = top;
});
function hidePop() { pop.hidden = true; popFor = null; }
// 車名の欄（実績バッジがある車両）にマウスを乗せると表示
$('#tbl').addEventListener('mouseover', (e) => {
  const td = e.target.closest('td[data-key="name"]');
  const badge = td?.querySelector('.mk-badge');
  if (!badge) return;
  clearTimeout(popTimer);
  popTimer = setTimeout(() => showMarket(td, badge.dataset.mk), 250);
});
$('#tbl').addEventListener('mouseout', (e) => {
  const td = e.target.closest('td[data-key="name"]');
  if (!td || td.contains(e.relatedTarget) || pop.contains(e.relatedTarget)) return;
  clearTimeout(popTimer);
  popTimer = setTimeout(hidePop, 200);
});
pop.addEventListener('mouseenter', () => clearTimeout(popTimer));
pop.addEventListener('mouseleave', () => { popTimer = setTimeout(hidePop, 200); });
// スマホ：実績バッジをタップで表示／もう一度タップで閉じる
$('#tbl').addEventListener('click', (e) => {
  const badge = e.target.closest('.mk-badge');
  if (!badge) return;
  e.stopPropagation();
  if (popFor === badge.dataset.mk && !pop.hidden) hidePop(); else showMarket(badge.closest('td'), badge.dataset.mk);
}, true);
document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.mk-badge')) hidePop(); });
$('.table-wrap').addEventListener('scroll', hidePop);

// 最初の表示：相場データの件数（型式ごと）を読み込んでから一覧を表示
loadMarketCounts().finally(load);
