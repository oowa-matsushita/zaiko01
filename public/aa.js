const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const man = (k) => (k == null || k === 0 ? '' : '¥' + (k * 1000).toLocaleString('ja-JP'));
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const dlabel = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}(${WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`; };

// 表の列 [キー, 見出し, 種類]
const COLS = [
  ['auction_date', '開催日', 'date'], ['venue', '会場'], ['lot_no', '出品番号', 'num'], ['year', '年式'],
  ['model_name', '車種'], ['grade', 'グレード'], ['mileage_k', '走行', 'km'], ['color', '色'], ['type_code', '型式'],
  ['serial', '車台番号'], ['score', '評価', 'c'], ['interior', '内装', 'c'], ['result', '結果'], ['price_k', '金額', 'yen'],
  ['start_k', 'スタート', 'yen'], ['region', '落札地区'], ['inspection', '車検'], ['equipment', '装備'],
];
const state = { q: '', date: '', result: '', rows: [], sort: { key: 'auction_date', dir: -1 } };

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { location.href = '/login'; throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

async function load() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.result) p.set('result', state.result);
  if (state.date) { p.set('from', state.date); p.set('to', state.date); }
  try {
    const d = await api('/api/market-list?' + p);
    state.rows = d.rows;
    const sel = $('#a-date');
    if (sel.options.length <= 1) sel.innerHTML += d.dates.map((x) => `<option value="${x}">${dlabel(x)}</option>`).join('');
    render();
  } catch (e) {
    $('#aa-tbl tbody').innerHTML = `<tr><td colspan="${COLS.length}" class="empty">読み込めませんでした：${esc(e.message)}</td></tr>`;
  }
}

const val = (r, k) => (['lot_no', 'mileage_k', 'price_k', 'start_k'].includes(k) ? Number(r[k]) : k === 'score' ? (parseFloat(r[k]) || -1) : r[k]);
function render() {
  const { key, dir } = state.sort;
  $('#aa-tbl thead tr').innerHTML = COLS.map(([k, l]) => `<th data-key="${k}">${l}<span class="arrow">${key === k ? (dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('');
  const rows = [...state.rows].sort((a, b) => {
    const x = val(a, key), y = val(b, key);
    if (x == null || x === '') return 1;
    if (y == null || y === '') return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ja')) * dir;
  });
  const sold = rows.filter((r) => /落札/.test(r.result || '') && r.price_k > 0).map((r) => r.price_k);
  $('#a-stat').innerHTML = `${rows.length} 件` + (sold.length ? `　落札 ${sold.length} 台・平均 <b>${man(Math.round(sold.reduce((a, b) => a + b, 0) / sold.length))}</b>` : '');
  $('#aa-tbl tbody').innerHTML = rows.length ? rows.map((r) => `<tr class="${r.in_stock ? 'aa-stock' : ''} ${/落札/.test(r.result || '') ? '' : 'aa-unsold'}">${COLS.map(([k, , t]) => {
    const v = t === 'date' ? dlabel(r[k]) : t === 'yen' ? man(r[k]) : t === 'km' ? (r[k] != null ? `${r[k]}千km` : '') : r[k];
    return `<td class="${t === 'yen' || t === 'km' || t === 'num' ? 'r' : t === 'c' ? 'c' : ''}${k === 'price_k' ? ' b' : ''}${k === 'equipment' ? ' w' : ''}">${esc(v)}</td>`;
  }).join('')}</tr>`).join('') : `<tr><td colspan="${COLS.length}" class="empty">該当する結果はありません。CSVは「データをアップロード」から取り込めます</td></tr>`;
}

$('#aa-tbl thead').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  state.sort = { key: th.dataset.key, dir: state.sort.key === th.dataset.key ? -state.sort.dir : (th.dataset.key === 'auction_date' ? -1 : 1) };
  render();
});
let t;
$('#aq').addEventListener('input', (e) => {
  clearTimeout(t);
  $('#aq-clear').hidden = !e.target.value;
  t = setTimeout(() => { state.q = e.target.value.normalize('NFKC').trim(); $('.search-box').classList.toggle('active', !!state.q); load(); }, 250);
});
$('#aq-clear').addEventListener('click', () => { $('#aq').value = ''; state.q = ''; $('#aq-clear').hidden = true; $('.search-box').classList.remove('active'); load(); });
$('#a-date').addEventListener('change', (e) => { state.date = e.target.value; load(); });
$('#a-result').addEventListener('change', (e) => { state.result = e.target.value; load(); });
load();
