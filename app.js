'use strict';
const VERSION = '1.0.0';
const KEY = 'elektromer.v1';
const DAY = 864e5;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'máj', 'jún', 'júl', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_FULL = ['január', 'február', 'marec', 'apríl', 'máj', 'jún', 'júl', 'august', 'september', 'október', 'november', 'december'];
const $ = (s, el = document) => el.querySelector(s);
const nf = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 1 });
const fmt = v => v == null ? '–' : nf.format(v);
const fmt1 = v => v == null ? '–' : (Math.abs(v) < 10 ? nf1.format(v) : nf.format(v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- storage ---------- */
let db = load();
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY));
    if (j && Array.isArray(j.readings)) return { readings: j.readings, prices: j.prices || [] };
  } catch (e) { /* ignore */ }
  return { readings: [], prices: [] };
}
function persist() {
  db.readings.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  db.prices.sort((a, b) => a.from < b.from ? -1 : 1);
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { alert('Nepodarilo sa uložiť dáta: ' + e.message); }
  cache = null;
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------- time helpers ---------- */
const pad = n => String(n).padStart(2, '0');
const localIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tsMs = ts => new Date(ts).getTime();
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const fmtDate = d => `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
const fmtDateShort = d => `${d.getDate()}. ${d.getMonth() + 1}.`;
const fmtTime = d => `${d.getHours()}:${pad(d.getMinutes())}`;
function ago(ms) {
  const h = (Date.now() - ms) / 36e5;
  if (h < 1) return 'pred chvíľou';
  if (h < 24) return `pred ${Math.round(h)} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'včera' : `pred ${d} dňami`;
}

/* ---------- consumption model ---------- */
// Each tariff is a monotonic counter; between readings we interpolate linearly.
let cache = null;
function series() {
  if (cache) return cache;
  const nt = [], vt = [];
  for (const r of db.readings) {
    const t = tsMs(r.ts);
    if (r.nt != null) nt.push({ t, v: r.nt });
    if (r.vt != null) vt.push({ t, v: r.vt });
  }
  const all = db.readings.map(r => tsMs(r.ts));
  cache = { nt, vt, first: all.length ? all[0] : null, last: all.length ? all[all.length - 1] : null };
  return cache;
}
function cumAt(s, t) {
  if (!s.length) return 0;
  if (t <= s[0].t) return s[0].v;
  const L = s[s.length - 1];
  if (t >= L.t) return L.v;
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= t) lo = m; else hi = m; }
  const a = s[lo], b = s[hi];
  return b.t === a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
}
const usage = (s, a, b) => s.length < 2 ? 0 : Math.max(0, cumAt(s, b) - cumAt(s, a));
function priceAt(day) { // day = 'YYYY-MM-DD'
  let p = null;
  for (const x of db.prices) if (x.from <= day) p = x;
  return p;
}
// Returns {nt, vt, cost|null, days} for [a, b)
function period(a, b) {
  const S = series();
  const out = { nt: usage(S.nt, a, b), vt: usage(S.vt, a, b), cost: null, days: 0 };
  if (S.first == null) return out;
  const lo = Math.max(a, S.first), hi = Math.min(b, S.last);
  out.days = Math.max(0, (hi - lo) / DAY);
  if (!db.prices.length || hi <= lo) return out;
  let cost = 0, priced = false;
  for (let d = startOfDay(new Date(a)); d.getTime() < b; d = addDays(d, 1)) {
    const d0 = Math.max(d.getTime(), a), d1 = Math.min(addDays(d, 1).getTime(), b);
    const p = priceAt(dayKey(d));
    if (!p) continue;
    priced = true;
    cost += usage(S.nt, d0, d1) * (+p.nt || 0) + usage(S.vt, d0, d1) * (+p.vt || 0);
    const fl = Math.max(d0, S.first), fh = Math.min(d1, S.last);
    if (fh > fl) cost += (+p.fixed || 0) * 12 / 365 * (fh - fl) / DAY;
  }
  out.cost = priced ? cost : null;
  return out;
}

/* ---------- navigation ---------- */
const views = { entry: renderEntry, stats: renderStats, hist: renderHist, set: renderSettings };
let current = 'entry';
function show(v) {
  current = v;
  for (const k of Object.keys(views)) $('#v-' + k).classList.toggle('hidden', k !== v);
  document.querySelectorAll('#tabs button').forEach(b => b.dataset.v === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  views[v]();
  window.scrollTo(0, 0);
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.v); });

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = 'none', 3200);
}

/* ---------- entry ---------- */
function lastOf(key, beforeMs = Infinity) {
  let r = null;
  for (const x of db.readings) { if (tsMs(x.ts) >= beforeMs) break; if (x[key] != null) r = x; }
  return r;
}
function nextOf(key, afterMs, excludeId) {
  for (const x of db.readings) if (x.id !== excludeId && tsMs(x.ts) > afterMs && x[key] != null) return x;
  return null;
}
function renderEntry() {
  const lnt = lastOf('nt'), lvt = lastOf('vt');
  const last = db.readings[db.readings.length - 1];
  $('#last-card').innerHTML = last
    ? `<div class="small muted">Posledný zápis · ${fmtDate(new Date(last.ts))} ${fmtTime(new Date(last.ts))} (${ago(tsMs(last.ts))})</div>
       <div class="row tabular" style="margin-top:4px;font-size:18px"><span><i class="swatch" style="background:var(--nt)"></i>NT <b>${fmt(lnt && lnt.nt)}</b></span><span style="margin-left:16px"><i class="swatch" style="background:var(--vt)"></i>VT <b>${fmt(lvt && lvt.vt)}</b></span></div>`
    : `<div>Zatiaľ žiadne zápisy. Históriu z Excelu nahráte v <b>Nastavenia → Obnoviť zo zálohy</b>.</div>`;
  $('#last-card').style.marginBottom = '12px';
  $('#in-nt').placeholder = lnt ? lnt.nt : 'stav NT';
  $('#in-vt').placeholder = lvt ? lvt.vt : 'stav VT';
  $('#nt-hint').textContent = lnt ? 'naposledy ' + lnt.nt : '';
  $('#vt-hint').textContent = lvt ? 'naposledy ' + lvt.vt : '';
  if (!$('#in-ts').dataset.touched) $('#in-ts').value = localIso(new Date());
  renderQuickTiles();
}
$('#in-ts').addEventListener('input', e => e.target.dataset.touched = '1');

function renderQuickTiles() {
  const now = new Date(), today = startOfDay(now).getTime();
  const t = period(today, now.getTime());
  const y = period(addDays(new Date(today), -1).getTime(), today);
  const m = period(startOfMonth(now).getTime(), now.getTime());
  const S = series();
  const tile = (k, p, extra) => p.days > 0
    ? `<div class="tile"><div class="k">${k}</div><div class="v">${fmt1(p.nt + p.vt)} <span class="small">kWh</span></div><div class="s">${extra}</div></div>`
    : `<div class="tile"><div class="k">${k}</div><div class="v">–</div><div class="s">bez zápisu</div></div>`;
  const costS = p => p.cost != null ? nf.format(p.cost) + ' Kč' : `NT ${fmt1(p.nt)} · VT ${fmt1(p.vt)}`;
  $('#quick-tiles').innerHTML = S.first == null ? '' :
    tile('Dnes', t, `NT ${fmt1(t.nt)} · VT ${fmt1(t.vt)}`) + tile('Včera', y, `NT ${fmt1(y.nt)} · VT ${fmt1(y.vt)}`) + tile(MONTHS_FULL[now.getMonth()], m, costS(m));
}

// Returns list of {level:'err'|'warn', text}
function checkReading(ts, vals, excludeId) {
  const issues = [];
  const t = tsMs(ts);
  const others = db.readings.filter(r => r.id !== excludeId);
  const saved = db.readings; db.readings = others; cache = null;
  try {
    for (const key of ['nt', 'vt']) {
      const v = vals[key]; if (v == null) continue;
      const name = key.toUpperCase();
      const prev = lastOf(key, t), next = nextOf(key, t, excludeId);
      if (prev && v < prev[key]) issues.push({ level: 'err', text: `${name} ${v} je nižší ako predchádzajúci stav ${prev[key]} (${fmtDateShort(new Date(prev.ts))}). Preklep?` });
      if (next && v > next[key]) issues.push({ level: 'err', text: `${name} ${v} je vyšší ako neskorší stav ${next[key]} (${fmtDateShort(new Date(next.ts))}).` });
      if (prev && v >= prev[key]) {
        const S = series()[key];
        const pt = tsMs(prev.ts);
        const span = Math.min(60 * DAY, pt - (S.length ? S[0].t : pt));
        const rate = span > 0 ? usage(S, pt - span, pt) / (span / DAY) : 0;
        const days = Math.max((t - pt) / DAY, 1);
        const limit = Math.max(50, rate * 4 * days);
        const delta = v - prev[key];
        if (delta > limit) issues.push({ level: 'warn', text: `${name} narástol o ${fmt(delta)} kWh za ${fmt1((t - pt) / DAY)} dňa – to je oveľa viac ako obvykle (~${fmt1(rate)} kWh/deň). Skontrolujte číslice.` });
      }
    }
  } finally { db.readings = saved; cache = null; }
  return issues;
}

function parseNum(s) {
  s = String(s).replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : NaN;
}

$('#entry-form').addEventListener('submit', async e => {
  e.preventDefault();
  const nt = parseNum($('#in-nt').value), vt = parseNum($('#in-vt').value);
  const msg = $('#entry-msg');
  if (Number.isNaN(nt) || Number.isNaN(vt)) { msg.innerHTML = `<div class="notice err">Zadajte iba číslo.</div>`; return; }
  if (nt == null && vt == null) { msg.innerHTML = `<div class="notice err">Vyplňte aspoň jeden tarif.</div>`; return; }
  const ts = $('#in-ts').value || localIso(new Date());
  const issues = checkReading(ts, { nt, vt });
  if (issues.length && !(await confirmIssues(issues))) return;
  const prevNt = lastOf('nt', tsMs(ts)), prevVt = lastOf('vt', tsMs(ts));
  db.readings.push({ id: 'r' + Date.now().toString(36), ts, nt, vt });
  persist();
  const parts = [];
  if (nt != null && prevNt) parts.push(`NT +${fmt1(nt - prevNt.nt)}`);
  if (vt != null && prevVt) parts.push(`VT +${fmt1(vt - prevVt.vt)}`);
  const since = prevNt || prevVt ? ` od ${fmtDateShort(new Date((prevNt || prevVt).ts))} ${fmtTime(new Date((prevNt || prevVt).ts))}` : '';
  msg.innerHTML = '';
  $('#in-nt').value = ''; $('#in-vt').value = '';
  delete $('#in-ts').dataset.touched;
  toast('Uložené ✓ ' + (parts.length ? parts.join(' · ') + ' kWh' + since : ''));
  renderEntry();
});

function confirmIssues(issues) {
  return new Promise(res => {
    const dlg = $('#dlg');
    dlg.innerHTML = `<h3 style="margin-top:0">Skontrolujte hodnoty</h3>
      ${issues.map(i => `<div class="notice ${i.level}">${esc(i.text)}</div>`).join('')}
      <div class="btns" style="margin-top:14px"><button data-a="0">Opraviť</button><button data-a="1" class="danger">Uložiť aj tak</button></div>`;
    dlg.onclick = e => { const b = e.target.closest('button'); if (b) { dlg.close(); res(b.dataset.a === '1'); } };
    dlg.oncancel = () => res(false);
    dlg.showModal();
  });
}

/* ---------- stats ---------- */
let range = 'd30';
$('#range-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { range = b.dataset.r; renderStats(); } });

function buckets(r) {
  const now = new Date(), S = series(), out = [];
  if (r === 'd7' || r === 'd30') {
    const n = r === 'd7' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const a = addDays(startOfDay(now), -i), b = addDays(a, 1);
      out.push({ a, b, label: r === 'd7' ? ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so'][a.getDay()] : String(a.getDate()), name: fmtDate(a) });
    }
  } else {
    let start = r === 'm12' ? addMonths(startOfMonth(now), -11) : startOfMonth(new Date(S.first || now));
    for (let a = start; a <= now; a = addMonths(a, 1)) {
      out.push({ a, b: addMonths(a, 1), label: MONTHS[a.getMonth()] + (a.getMonth() === 0 || out.length === 0 ? ' ' + String(a.getFullYear()).slice(2) : ''), name: MONTHS_FULL[a.getMonth()] + ' ' + a.getFullYear() });
    }
  }
  for (const k of out) Object.assign(k, period(k.a.getTime(), k.b.getTime()));
  return out;
}

function renderStats() {
  document.querySelectorAll('#range-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.r === range));
  const S = series();
  if (S.first == null) { $('#kpi').innerHTML = ''; $('#chart').innerHTML = '<p class="muted">Zatiaľ žiadne dáta.</p>'; $('#year-table').innerHTML = ''; return; }
  const bs = buckets(range);
  const a = bs[0].a.getTime(), b = Math.min(bs[bs.length - 1].b.getTime(), Date.now());
  const tot = period(a, b);
  const sum = tot.nt + tot.vt;
  const perDay = tot.days > 0 ? sum / tot.days : 0;
  $('#kpi').innerHTML =
    `<div class="tile"><div class="k">Spotreba</div><div class="v">${fmt(sum)}</div><div class="s">kWh</div></div>` +
    `<div class="tile"><div class="k">Priemer / deň</div><div class="v">${fmt1(perDay)}</div><div class="s">NT ${Math.round(sum ? tot.nt / sum * 100 : 0)} % · VT ${Math.round(sum ? tot.vt / sum * 100 : 0)} %</div></div>` +
    `<div class="tile"><div class="k">Náklady</div><div class="v">${tot.cost != null ? fmt(tot.cost) : '–'}</div><div class="s">${tot.cost != null ? 'Kč odhad' : 'zadajte ceny'}</div></div>`;
  const monthly = range === 'm12' || range === 'all';
  $('#chart-title').textContent = monthly ? 'kWh za mesiac' : 'kWh za deň';
  barChart($('#chart'), bs, monthly);
  const lastD = new Date(S.last);
  $('#chart-note').textContent = `Medzi zápismi sa spotreba rozpočítava rovnomerne. Údaje do ${fmtDate(lastD)} ${fmtTime(lastD)}.`;
  renderYearTable();
}

function niceScale(v) { // -> {max, step} with 3–5 round ticks
  if (!(v > 0)) return { max: 4, step: 1 };
  const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(v / step) * step, step };
}
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function barChart(el, data, monthly) {
  const W = Math.max(280, el.clientWidth || 340), H = 210;
  const pl = 38, pr = 6, pt = 10, pb = 24;
  const iw = W - pl - pr, ih = H - pt - pb;
  const { max, step } = niceScale(Math.max(...data.map(d => d.nt + d.vt)));
  const y = v => pt + ih - v / max * ih;
  const band = iw / data.length, bw = Math.max(2, Math.min(band - 2, band * 0.72, 30));
  let g = '';
  for (let i = 0; i * step <= max + 1e-9; i++) {
    const v = i * step, yy = y(v);
    g += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"${i ? ' stroke-dasharray="2 3"' : ''}/>`;
    g += `<text x="${pl - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(v)}</text>`;
  }
  const every = Math.ceil(data.length / 8);
  let bars = '';
  data.forEach((d, i) => {
    const x = pl + i * band + (band - bw) / 2;
    const hn = d.nt / max * ih, hv = d.vt / max * ih;
    const base = pt + ih;
    const gap = hn > 0 && hv > 0 ? 2 : 0;
    let s = '';
    if (hn > 0) s += hv > 0 ? `<rect x="${x}" y="${base - hn}" width="${bw}" height="${hn}" fill="var(--nt)"/>` : `<path d="${topRounded(x, base - hn, bw, hn, 4)}" fill="var(--nt)"/>`;
    if (hv > 0) s += `<path d="${topRounded(x, base - hn - gap - hv, bw, hv, 4)}" fill="var(--vt)"/>`;
    bars += `<g class="bar" data-i="${i}">${s}</g>`;
    if ((data.length - 1 - i) % every === 0) bars += `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(d.label)}</text>`;
  });
  let hits = '';
  data.forEach((d, i) => hits += `<rect class="hit" data-i="${i}" x="${pl + i * band}" y="${pt}" width="${band}" height="${ih}" fill="transparent"/>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graf spotreby">${g}${bars}${hits}</svg><div class="tip"></div>`;
  const tip = $('.tip', el), svg = $('svg', el);
  const showTip = i => {
    const d = data[i];
    svg.querySelectorAll('g.bar').forEach(b => b.style.opacity = +b.dataset.i === i ? 1 : .35);
    tip.innerHTML = `<b>${esc(d.name)}</b><br>${fmt1(d.nt + d.vt)} kWh · NT ${fmt1(d.nt)} · VT ${fmt1(d.vt)}${d.cost != null ? '<br>' + fmt(d.cost) + ' Kč' : ''}`;
    tip.style.display = 'block';
    const cx = (pl + i * band + band / 2) / W * el.clientWidth;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(cx, tw / 2), el.clientWidth - tw / 2) + 'px';
    tip.style.top = '-6px';
  };
  const hide = () => { tip.style.display = 'none'; svg.querySelectorAll('g.bar').forEach(b => b.style.opacity = 1); };
  svg.addEventListener('pointermove', e => { const h = e.target.closest('.hit'); if (h) showTip(+h.dataset.i); });
  svg.addEventListener('pointerdown', e => { const h = e.target.closest('.hit'); if (h) showTip(+h.dataset.i); });
  svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
}

function renderYearTable() {
  const S = series();
  const y0 = new Date(S.first).getFullYear(), y1 = new Date().getFullYear();
  const years = []; for (let y = y0; y <= y1; y++) years.push(y);
  let h = `<tr><th>Mesiac</th>${years.map(y => `<th>${y}</th>`).join('')}</tr>`;
  const totals = years.map(() => 0);
  for (let m = 0; m < 12; m++) {
    h += `<tr><td>${MONTHS_FULL[m]}</td>`;
    years.forEach((y, j) => {
      const a = new Date(y, m, 1).getTime(), b = new Date(y, m + 1, 1).getTime();
      const p = period(a, b), v = p.nt + p.vt;
      const full = a >= S.first - DAY && b <= S.last + DAY;
      totals[j] += v;
      h += `<td>${v > 0 ? fmt(v) + (full ? '' : '*') : '<span class="muted">–</span>'}</td>`;
    });
    h += '</tr>';
  }
  h += `<tr><th>Spolu</th>${totals.map(t => `<th>${fmt(t)}</th>`).join('')}</tr>`;
  $('#year-table').innerHTML = h + `<caption style="caption-side:bottom;text-align:left;font-size:12px;color:var(--muted);padding-top:6px">* neúplný mesiac (mimo obdobia zápisov)</caption>`;
}

/* ---------- history ---------- */
let histLimit = 120;
$('#hist-more').addEventListener('click', () => { histLimit += 200; renderHist(); });
function renderHist() {
  const rs = db.readings;
  const lastVal = { nt: null, vt: null };
  const deltas = new Map();
  for (const r of rs) {
    const d = {};
    for (const k of ['nt', 'vt']) if (r[k] != null) { if (lastVal[k] != null) d[k] = r[k] - lastVal[k]; lastVal[k] = r[k]; }
    deltas.set(r.id, d);
  }
  let h = '', day = '';
  const list = rs.slice(-histLimit).reverse();
  for (const r of list) {
    const d = new Date(r.ts), k = dayKey(d);
    if (k !== day) { day = k; h += `<div class="hist-day">${['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'][d.getDay()]} ${fmtDate(d)}</div>`; }
    const dl = deltas.get(r.id);
    h += `<button class="hist-item" data-id="${esc(r.id)}"><span class="t">${r.approxTime ? '≈' : fmtTime(d)}</span>
      <span class="vals"><i class="swatch" style="background:var(--nt)"></i>${fmt(r.nt)}&nbsp;&nbsp;<i class="swatch" style="background:var(--vt)"></i>${fmt(r.vt)}</span>
      <span class="d">${dl.nt != null ? '+' + fmt1(dl.nt) + ' NT' : ''}${dl.vt != null ? '<br>+' + fmt1(dl.vt) + ' VT' : ''}</span></button>`;
  }
  $('#hist-list').innerHTML = h || '<p class="muted">Zatiaľ žiadne zápisy.</p>';
  $('#hist-more').classList.toggle('hidden', rs.length <= histLimit);
}
$('#hist-list').addEventListener('click', e => { const b = e.target.closest('.hist-item'); if (b) editReading(b.dataset.id); });

function editReading(id) {
  const r = db.readings.find(x => x.id === id); if (!r) return;
  const dlg = $('#dlg');
  dlg.innerHTML = `<h3 style="margin-top:0">Upraviť zápis</h3>
    <label class="field"><span>NT</span><input id="e-nt" inputmode="numeric" value="${r.nt ?? ''}"></label>
    <label class="field"><span>VT</span><input id="e-vt" inputmode="numeric" value="${r.vt ?? ''}"></label>
    <label class="field"><span>Dátum a čas${r.approxTime ? ' (približný)' : ''}</span><input id="e-ts" type="datetime-local" value="${r.ts}"></label>
    <div id="e-msg"></div>
    <div class="btns"><button data-a="del" class="danger">Zmazať</button><button data-a="x">Zrušiť</button><button data-a="ok" class="primary" style="width:auto">Uložiť</button></div>`;
  dlg.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.a === 'x') return dlg.close();
    if (b.dataset.a === 'del') {
      if (!confirm('Naozaj zmazať tento zápis?')) return;
      db.readings = db.readings.filter(x => x.id !== id); persist(); dlg.close(); toast('Zápis zmazaný'); renderHist(); return;
    }
    const nt = parseNum($('#e-nt').value), vt = parseNum($('#e-vt').value), ts = $('#e-ts').value;
    if (Number.isNaN(nt) || Number.isNaN(vt) || (nt == null && vt == null) || !ts) { $('#e-msg').innerHTML = '<div class="notice err">Skontrolujte hodnoty.</div>'; return; }
    const issues = checkReading(ts, { nt, vt }, id);
    if (issues.length) {
      const ok = window.confirm('Upozornenie:\n\n' + issues.map(i => '• ' + i.text).join('\n') + '\n\nUložiť aj tak?');
      if (!ok) return;
    }
    Object.assign(r, { nt, vt });
    if (ts !== r.ts) { r.ts = ts; delete r.approxTime; }
    persist(); dlg.close(); toast('Zápis upravený'); renderHist();
  };
  dlg.oncancel = null;
  dlg.showModal();
}

/* ---------- settings ---------- */
function renderSettings() {
  $('#ver').textContent = VERSION;
  const S = series();
  $('#data-info').textContent = db.readings.length
    ? `${db.readings.length} zápisov od ${fmtDate(new Date(S.first))} do ${fmtDate(new Date(S.last))}.`
    : 'Zatiaľ žiadne zápisy.';
  renderPrices();
  const th = localStorage.getItem('elektromer.theme') || 'auto';
  document.querySelectorAll('#theme-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === th));
}
function priceRow(p = {}) {
  return `<div class="price-row">
    <div><label>Platí od</label><input type="date" data-f="from" value="${esc(p.from || dayKey(new Date()))}"></div>
    <div><label>NT Kč/kWh</label><input inputmode="decimal" data-f="nt" value="${p.nt ?? ''}"></div>
    <div><label>VT Kč/kWh</label><input inputmode="decimal" data-f="vt" value="${p.vt ?? ''}"></div>
    <div><label>Kč/mes.</label><input inputmode="decimal" data-f="fixed" value="${p.fixed ?? ''}"></div>
    <button class="link" data-del aria-label="Odstrániť" style="padding:10px 4px">✕</button></div>`;
}
function renderPrices() {
  $('#price-list').innerHTML = db.prices.length ? db.prices.map(priceRow).join('') : priceRow();
}
$('#price-list').addEventListener('click', e => { if (e.target.closest('[data-del]')) e.target.closest('.price-row').remove(); });
$('#price-add').addEventListener('click', () => $('#price-list').insertAdjacentHTML('beforeend', priceRow()));
$('#price-save').addEventListener('click', () => {
  const rows = [...document.querySelectorAll('#price-list .price-row')].map(row => {
    const o = {}; row.querySelectorAll('input').forEach(i => o[i.dataset.f] = i.dataset.f === 'from' ? i.value : parseNum(i.value)); return o;
  }).filter(o => o.from && (o.nt != null || o.vt != null || o.fixed != null));
  if (rows.some(o => [o.nt, o.vt, o.fixed].some(Number.isNaN))) { toast('Ceny musia byť čísla'); return; }
  db.prices = rows; persist(); renderPrices(); toast('Ceny uložené ✓');
});

async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => dayKey(new Date());
$('#exp-csv').addEventListener('click', () => {
  const lines = ['Dátum;Čas;VT;NT;Spotreba VT;Spotreba NT;Poznámka'];
  const last = { nt: null, vt: null };
  for (const r of db.readings) {
    const d = new Date(r.ts), dv = {};
    for (const k of ['nt', 'vt']) if (r[k] != null) { dv[k] = last[k] != null ? r[k] - last[k] : ''; last[k] = r[k]; }
    lines.push([fmtDate(d).replace(/ /g, ''), r.approxTime ? '' : fmtTime(d), r.vt ?? '', r.nt ?? '', dv.vt ?? '', dv.nt ?? '', r.approxTime ? 'približný čas' : ''].join(';'));
  }
  deliver(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `elektromer-${stamp()}.csv`);
});
$('#exp-json').addEventListener('click', () => {
  const data = { app: 'elektromer', version: 1, exported: new Date().toISOString(), readings: db.readings, prices: db.prices };
  deliver(new Blob([JSON.stringify(data)], { type: 'application/json' }), `elektromer-zaloha-${stamp()}.json`);
});
$('#imp-json').addEventListener('click', () => $('#imp-file').click());
$('#imp-file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let j;
  try { j = JSON.parse(await f.text()); } catch { toast('Súbor nie je platná záloha'); return; }
  if (!j || !Array.isArray(j.readings) || j.readings.some(r => !r || typeof r.ts !== 'string')) { toast('Súbor nie je platná záloha'); return; }
  const rs = j.readings.map((r, i) => ({ id: String(r.id || 'i' + i), ts: r.ts.slice(0, 16), nt: r.nt ?? null, vt: r.vt ?? null, ...(r.approxTime ? { approxTime: true } : {}) }));
  const dlg = $('#dlg');
  dlg.innerHTML = `<h3 style="margin-top:0">Obnoviť zo zálohy</h3><p>Súbor obsahuje <b>${rs.length}</b> zápisov${j.prices && j.prices.length ? ' a cenník' : ''}. V appke je teraz ${db.readings.length} zápisov.</p>
    <div class="btns" style="flex-direction:column"><button data-a="merge" class="primary">Pridať k existujúcim</button><button data-a="replace" class="danger">Nahradiť všetko</button><button data-a="x">Zrušiť</button></div>`;
  dlg.onclick = ev => {
    const b = ev.target.closest('button'); if (!b) return; dlg.close();
    if (b.dataset.a === 'x') return;
    if (b.dataset.a === 'replace') { db.readings = rs; if (j.prices) db.prices = j.prices; }
    else {
      const seen = new Set(db.readings.map(r => `${r.ts}|${r.nt}|${r.vt}`));
      const ids = new Set(db.readings.map(r => r.id));
      for (const r of rs) if (!seen.has(`${r.ts}|${r.nt}|${r.vt}`)) { if (ids.has(r.id)) r.id += '_' + Math.random().toString(36).slice(2, 6); db.readings.push(r); }
      if (!db.prices.length && j.prices) db.prices = j.prices;
    }
    persist(); toast(`Hotovo – ${db.readings.length} zápisov`); renderSettings();
  };
  dlg.showModal();
});

function applyTheme() {
  const t = localStorage.getItem('elektromer.theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}
$('#theme-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  localStorage.setItem('elektromer.theme', b.dataset.t); applyTheme(); renderSettings();
});
applyTheme();

/* ---------- boot ---------- */
window.addEventListener('resize', () => { if (current === 'stats') renderStats(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && current === 'entry') renderEntry(); });
show('entry');
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
