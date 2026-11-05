const $ = (s) => document.querySelector(s);
const yen = (n) => (n == null ? '-' : '¥' + Number(n).toLocaleString('ja-JP'));
const STATUS_LABEL = { in_stock: '在庫', listed: '出品中', sold: '売却済' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

const state = { q: '', status: '', sort: 'purchase_date_desc', items: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

async function load() {
  const p = new URLSearchParams({ sort: state.sort, limit: '1000' });
  if (state.q) p.set('q', state.q);
  if (state.status) p.set('status', state.status);
  try {
    const data = await api('/api/items?' + p);
    state.items = data.items;
    render(data);
  } catch (e) {
    $('#list').innerHTML = `<li class="empty">読み込みに失敗しました：${esc(e.message)}</li>`;
  }
  loadStats();
}

function render({ items, total }) {
  $('#count').textContent = `${total} 件`;
  if (!items.length) {
    $('#list').innerHTML = '<li class="empty">該当する在庫がありません</li>';
    return;
  }
  $('#list').innerHTML = items.map((it) => {
    const meta = [it.model_no, it.condition_rank && `ランク${it.condition_rank}`, it.location && `📦${it.location}`, it.supplier]
      .filter(Boolean).map(esc).join(' ・ ');
    const days = it.status !== 'sold' && it.purchase_date
      ? Math.floor((Date.parse(today()) - Date.parse(it.purchase_date)) / 864e5) : null;
    const profit = it.profit != null
      ? `<div class="${it.profit >= 0 ? 'plus' : 'minus'}">利益 ${yen(it.profit)}</div>` : '';
    const quick = it.status === 'sold' ? '' : `<div class="quick">
        ${it.status === 'in_stock' ? `<button data-act="listed" data-id="${it.id}">出品</button>` : ''}
        <button data-act="sold" data-id="${it.id}">売却</button></div>`;
    return `<li class="item" data-id="${it.id}">
      <div>
        <div class="name"><span class="badge ${it.status}">${STATUS_LABEL[it.status]}</span>${esc(it.name)}${it.quantity > 1 ? ` ×${it.quantity}` : ''}</div>
        <div class="meta">${meta || '&nbsp;'}</div>
        <div class="meta">買取 ${esc(it.purchase_date || '日付なし')}${days != null ? `（${days}日経過）` : ''}${it.sold_date ? ` → 売却 ${esc(it.sold_date)}` : ''}</div>
      </div>
      <div class="right">
        <div class="price">${yen(it.purchase_price)}</div>
        ${it.sold_price != null ? `<div class="meta">売 ${yen(it.sold_price)}</div>` : it.list_price != null ? `<div class="meta">予定 ${yen(it.list_price)}</div>` : ''}
        ${profit}${quick}
      </div>
    </li>`;
  }).join('');
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    const by = Object.fromEntries(s.stock.map((r) => [r.status, r]));
    const ym = today().slice(0, 7);
    const m = s.monthly_sales.find((r) => r.month === ym) || { sales: 0, profit: 0, sold_count: 0 };
    const p = s.monthly_purchases.find((r) => r.month === ym) || { purchase_total: 0, count: 0 };
    const stockCount = (by.in_stock?.count || 0) + (by.listed?.count || 0);
    const stockValue = (by.in_stock?.purchase_total || 0) + (by.listed?.purchase_total || 0);
    $('#stats').innerHTML = [
      ['在庫（出品中含む）', `${stockCount} 件`],
      ['在庫の買取総額', yen(stockValue)],
      ['今月の買取', `${yen(p.purchase_total)}（${p.count}件）`],
      ['今月の売上', `${yen(m.sales)}（${m.sold_count}件）`],
      ['今月の利益', yen(m.profit)],
    ].map(([l, v]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
  } catch { /* 集計は失敗しても一覧は表示する */ }
  fillSuggestions();
}

function fillSuggestions() {
  for (const f of ['category', 'supplier', 'location']) {
    const vals = [...new Set(state.items.map((i) => i[f]).filter(Boolean))].sort();
    $(`#dl-${f}`).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  }
}

// ---- フォーム ----
const dlg = $('#dlg');
const form = $('#form');

function openForm(item) {
  form.reset();
  $('#form-error').textContent = '';
  $('#dlg-title').textContent = item ? '在庫を編集' : '買取登録';
  $('#btn-delete').hidden = !item;
  const data = item || { purchase_date: today(), quantity: 1, status: 'in_stock' };
  for (const el of form.elements) {
    if (el.name && el.name in data) el.value = data[el.name] ?? '';
  }
  if (!item) form.elements.id.value = '';
  updateSoldFields();
  dlg.showModal();
  if (!item) form.elements.name.focus();
}

function updateSoldFields() {
  const sold = form.elements.status.value === 'sold';
  $('.sold-fields').hidden = !sold;
  if (sold && !form.elements.sold_date.value) form.elements.sold_date.value = today();
  const sp = Number(form.elements.sold_price.value);
  const pp = Number(form.elements.purchase_price.value || 0);
  const fee = Number(form.elements.fees.value || 0);
  $('.profit-preview').textContent = form.elements.sold_price.value !== ''
    ? `利益見込み：${yen(sp - pp - fee)}` : '';
}
form.addEventListener('input', updateSoldFields);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of form.elements) if (el.name && el.name !== 'id') body[el.name] = el.value;
  if (body.status !== 'sold') { body.sold_date = ''; body.sold_price = ''; }
  const id = form.elements.id.value;
  try {
    await api(id ? `/api/items/${id}` : '/api/items', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    dlg.close();
    load();
  } catch (err) {
    $('#form-error').textContent = err.message;
  }
});

$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-delete').addEventListener('click', async () => {
  const id = form.elements.id.value;
  if (!id || !confirm('この在庫を削除しますか？')) return;
  try { await api(`/api/items/${id}`, { method: 'DELETE' }); dlg.close(); load(); }
  catch (err) { $('#form-error').textContent = err.message; }
});
$('#btn-add').addEventListener('click', () => openForm(null));

// ---- 一覧の操作 ----
$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    e.stopPropagation();
    const item = state.items.find((i) => i.id == btn.dataset.id);
    if (btn.dataset.act === 'sold') {
      openForm({ ...item, status: 'sold' });
    } else {
      await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.act }) }).catch((err) => alert(err.message));
      load();
    }
    return;
  }
  const li = e.target.closest('.item');
  if (li) openForm(state.items.find((i) => i.id == li.dataset.id));
});

let timer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250);
});
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  state.status = b.dataset.status;
  load();
}));
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });

// ---- CSV出力（表示中の一覧） ----
$('#btn-csv').addEventListener('click', () => {
  const cols = [['id', 'ID'], ['name', '品名'], ['model_no', '型番・JAN'], ['category', 'カテゴリ'], ['condition_rank', '状態'],
    ['quantity', '数量'], ['purchase_date', '買取日'], ['purchase_price', '買取価格'], ['supplier', '仕入先'],
    ['location', '保管場所'], ['list_price', '販売予定価格'], ['status', 'ステータス'], ['sold_date', '販売日'],
    ['sold_price', '販売価格'], ['fees', '手数料'], ['profit', '利益'], ['notes', 'メモ']];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map((c) => cell(c[1])).join(',')].concat(state.items.map((it) =>
    cols.map(([k]) => cell(k === 'status' ? STATUS_LABEL[it[k]] : it[k])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `zaiko_${today()}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
});

load();
