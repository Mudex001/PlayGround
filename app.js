const COINS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', binance: 'BTC', icon: '₿', cls: 'btc', color: '#f7931a' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', binance: 'ETH', icon: 'Ξ', cls: 'eth', color: '#8a9cff' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB', binance: 'BNB', icon: '◆', cls: 'bnb', color: '#f0b90b' },
];
const state = { fiat: 'USDT', fiatSymbol: '$', interval: 30000, range: '24h', data: {}, timer: null, countdown: null, nextAt: 0 };

const $ = (s) => document.querySelector(s);
const cardsEl = $('#cards'), tableBody = $('#tableBody'), statusText = $('#statusText'),
  statusDot = $('#statusDot'), updatedAt = $('#updatedAt'), sourceEl = $('#source'),
  errorEl = $('#error'), refreshBtn = $('#refreshBtn'), bar = $('#countdownBar');

const FIAT_SYMBOLS = { USDT: '$', EUR: '€', GBP: '£' };
const fmtMoney = (n) => {
  if (n == null || isNaN(n)) return '—';
  const sym = FIAT_SYMBOLS[state.fiat] || '$';
  return sym + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 });
};
const fmtNum = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtCompact = (n, sym = true) => {
  if (n == null || isNaN(n)) return '—';
  const prefix = sym ? (FIAT_SYMBOLS[state.fiat] || '$') : '';
  const abs = Math.abs(n);
  const unit = abs >= 1e12 ? ['T', 1e12] : abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : ['', 1];
  return prefix + (n / unit[1]).toLocaleString('en-US', { maximumFractionDigits: 2 }) + unit[0];
};

function setStatus(msg, ok = true) {
  statusText.textContent = msg;
  statusDot.className = 'dot ' + (ok ? 'live' : 'err');
}
function showError(msg) {
  if (!msg) { errorEl.classList.add('hidden'); return; }
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

// ---- data fetching (all CORS-friendly, no API key) ----
// Primary: CoinLore tickers (CORS *, covers BTC+ETH+BNB, USD-based)
// Secondary: Coinbase spot (BTC/ETH) + CoinGecko simple price
// Fiat: Frankfurter USD->EUR/GBP rates, with static fallback

const FX_FALLBACK = { USDT: 1, EUR: 0.92, GBP: 0.79 };

async function fetchFx() {
  if (state.fiat === 'USDT') return 1;
  try {
    const r = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${state.fiat}`);
    if (!r.ok) throw new Error('fx HTTP ' + r.status);
    const j = await r.json();
    if (j.rates && j.rates[state.fiat]) return j.rates[state.fiat];
    throw new Error('no rate');
  } catch { return FX_FALLBACK[state.fiat] || 1; }
}

async function fetchCoinLore() {
  const r = await fetch('https://api.coinlore.net/api/tickers/?start=0&limit=30');
  if (!r.ok) throw new Error('CoinLore HTTP ' + r.status);
  const j = await r.json();
  const out = {};
  for (const c of COINS) {
    const t = (j.data || []).find(x => x.symbol === c.symbol);
    if (!t) continue;
    const priceUsd = parseFloat(t.price_usd);
    const chg24 = parseFloat(t.percent_change_24h);
    const chg7 = parseFloat(t.percent_change_7d);
    out[c.symbol] = {
      priceUsd, changePct: chg24, change7d: chg7,
      high: null, low: null,
      volume: parseFloat(t.volume24a) || parseFloat(t.volume24),
      quoteVolume: parseFloat(t.volume24a) || null,
      marketCap: parseFloat(t.market_cap_usd),
    };
  }
  if (!out.BTC) throw new Error('CoinLore missing BTC');
  return { out, source: 'CoinLore' };
}

async function fetchCoinbaseSpot() {
  // BTC + ETH only (Coinbase does not list BNB)
  const out = {};
  for (const sym of ['BTC', 'ETH']) {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
    if (!r.ok) throw new Error('Coinbase HTTP ' + r.status);
    const j = await r.json();
    out[sym] = { priceUsd: parseFloat(j.data.amount), changePct: null, high: null, low: null, volume: null, quoteVolume: null };
  }
  return { out, source: 'Coinbase' };
}

async function fetchCoinGecko() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true';
  const r = await fetch(url);
  if (!r.ok) throw new Error('CoinGecko HTTP ' + r.status);
  const j = await r.json();
  const out = {};
  for (const c of COINS) {
    const d = j[c.id];
    if (!d || d.usd == null) continue;
    out[c.symbol] = {
      priceUsd: d.usd, changePct: d.usd_24h_change, high: null, low: null,
      volume: null, quoteVolume: d.usd_24h_vol,
    };
  }
  if (!out.BTC) throw new Error('CoinGecko missing BTC');
  return { out, source: 'CoinGecko' };
}

// Hourly closes for charts via Coinbase Exchange candles (public, CORS *).
// BNB is not listed on Coinbase -> null (synthetic walk used instead).
async function fetchCandles(sym) {
  if (sym === 'BNB') return null;
  const is7d = state.range === '7d';
  const url = `https://api.exchange.coinbase.com/products/${sym}-USD/candles?granularity=${is7d ? 21600 : 3600}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('candles HTTP ' + r.status);
  const arr = await r.json(); // newest-first [time, low, high, open, close, volume]
  if (!Array.isArray(arr) || arr.length < 2) throw new Error('bad candles');
  const closes = arr.map(k => k[4]).reverse();
  return closes.slice(is7d ? -28 : -24);
}

// Deterministic pseudo-random walk anchored at live price & 24h change,
// used when exchange candles are unavailable. Labeled as estimate in UI.
function synthCloses(priceUsd, changePct) {
  const n = state.range === '7d' ? 28 : 24;
  const chg = (isFinite(changePct) ? changePct : 0) / 100;
  const start = priceUsd / (1 + chg);
  let seed = Math.floor(priceUsd) % 100000 || 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const trend = start + (priceUsd - start) * (i / (n - 1));
    pts.push(trend * (1 + (rnd() - 0.5) * 0.004));
  }
  pts[n - 1] = priceUsd;
  return pts;
}

function sampleData() {
  // Last-resort offline snapshot so the page never renders empty.
  return {
    BTC: { priceUsd: 83148.09, changePct: -0.92, change7d: -2.79, volume: 23972516, quoteVolume: 32372673913, closes: null },
    ETH: { priceUsd: 2675.60, changePct: -0.80, change7d: -2.24, volume: 8123456, quoteVolume: 22345678901, closes: null },
    BNB: { priceUsd: 812.44, changePct: 0.65, change7d: 1.20, volume: 1234567, quoteVolume: 1002345678, closes: null },
  };
}

function applyFx(out, rate) {
  for (const k of Object.keys(out)) {
    const d = out[k];
    d.price = d.priceUsd != null ? d.priceUsd * rate : null;
    if (d.quoteVolume != null) d.quoteVolume = d.quoteVolume * rate;
    if (d.marketCap != null) d.marketCap = d.marketCap * rate;
    if (d.closesUsd) d.closes = d.closesUsd.map(v => v * rate);
  }
  return out;
}

async function loadAll(manual = false) {
  refreshBtn.disabled = true;
  if (manual) setStatus('Refreshing…');
  showError('');
  let data = null, source = '', live = true, notes = [];
  const attempts = [fetchCoinLore, fetchCoinGecko, fetchCoinbaseSpot];
  let lastErr = null;
  for (const fn of attempts) {
    try { const res = await fn(); data = res.out; source = res.source; break; }
    catch (e) { lastErr = e; }
  }
  if (!data) {
    // offline: cached data, else embedded sample snapshot
    try {
      const cached = JSON.parse(localStorage.getItem('cryptopulse-cache') || 'null');
      if (cached && cached.data && cached.data.BTC) { data = cached.data; source = 'cache (offline)'; }
    } catch {}
    if (!data) { data = sampleData(); source = 'offline snapshot'; }
    live = false;
  }
  const fx = await fetchFx();
  // charts: exchange candles where available, else anchored synthetic walk
  let chartNote = '';
  await Promise.all(COINS.map(async (c) => {
    const d = data[c.symbol];
    if (!d) return;
    try {
      const closes = await fetchCandles(c.symbol);
      if (closes) { d.closesUsd = closes; return; }
      throw new Error('no candles');
    } catch {
      if (d.priceUsd != null) { d.closesUsd = synthCloses(d.priceUsd, d.changePct); chartNote = 'BNB trend estimated'; }
      else d.closesUsd = null;
    }
  }));
  applyFx(data, fx);
  state.data = data;
  render();
  const now = new Date();
  updatedAt.textContent = 'updated ' + now.toLocaleTimeString();
  sourceEl.textContent = 'source: ' + source;
  if (chartNote) sourceEl.textContent += ' · ' + chartNote;
  if (live) {
    setStatus(`Live · ${COINS.length} assets · every ${state.interval ? state.interval/1000 + 's' : 'paused'}`);
  } else {
    setStatus('Offline — showing ' + source, false);
    showError('Live fetch failed (' + String((lastErr && lastErr.message) || 'network unreachable') + '). Showing last available data; it will retry automatically.');
  }
  try { localStorage.setItem('cryptopulse-cache', JSON.stringify({ at: Date.now(), fiat: state.fiat, data })); } catch {}
  refreshBtn.disabled = false;
  restartCountdown();
}

function sparkline(canvas, closes, color, changePct) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth * 2;
  const H = canvas.height = 144;
  ctx.clearRect(0,0,W,H);
  if (!closes || closes.length < 2) { ctx.fillStyle='#9aa6c4'; ctx.font='24px sans-serif'; ctx.fillText('no chart data', 20, 70); return; }
  const min = Math.min(...closes), max = Math.max(...closes);
  const pad = (max-min) * 0.15 || max * 0.001 || 1;
  const lo = min-pad, hi = max+pad;
  const X = (i) => 8 + (W-16) * i/(closes.length-1);
  const Y = (v) => H-10 - (H-20) * (v-lo)/(hi-lo);
  // gradient fill
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0, color+'55'); grad.addColorStop(1, color+'00');
  ctx.beginPath(); ctx.moveTo(X(0), Y(closes[0]));
  closes.forEach((v,i)=>ctx.lineTo(X(i),Y(v)));
  ctx.lineTo(X(closes.length-1),H); ctx.lineTo(X(0),H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath(); closes.forEach((v,i)=> i?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineJoin='round'; ctx.stroke();
  // last dot
  ctx.beginPath(); ctx.arc(X(closes.length-1), Y(closes[closes.length-1]), 7, 0, 7);
  ctx.fillStyle = color; ctx.fill();
}

function render() {
  cardsEl.innerHTML = COINS.map(c => {
    const d = state.data[c.symbol] || {};
    const up = (d.changePct || 0) >= 0;
    return `<article class="card" style="--coin:${c.color}">
      <div class="coin-head"><div class="icon ${c.cls}">${c.icon}</div>
        <div><h2>${c.name} <small>${c.symbol} / ${state.fiat}</small></h2></div></div>
      <div class="price">${fmtMoney(d.price)}</div>
      <span class="chg ${up?'up':'down'}">${up?'▲':'▼'} ${d.changePct==null?'—':Math.abs(d.changePct).toFixed(2)+'%'} (24h)</span>
      <div class="stats">
        <div><span>7d Change</span><b>${d.change7d==null?'—':(d.change7d>=0?'▲ ':'▼ ')+Math.abs(d.change7d).toFixed(2)+'%'}</b></div>
        <div><span>Turnover (24h)</span><b>${fmtCompact(d.quoteVolume)}</b></div>
        <div><span>Market Cap</span><b>${fmtCompact(d.marketCap)}</b></div>
        <div><span>Volume (24h)</span><b>${d.volume==null?'—':fmtCompact(d.volume, false)}</b></div>
      </div>
      <canvas class="spark" data-coin="${c.symbol}" aria-label="${c.name} trend chart"></canvas>
      <div class="foot"><span>${c.name} trend · ${state.range}</span><span>● live</span></div>
    </article>`;
  }).join('');
  tableBody.innerHTML = COINS.map(c => {
    const d = state.data[c.symbol] || {};
    const up = (d.changePct || 0) >= 0;
    return `<tr><td><b>${c.icon} ${c.name}</b> <span style="color:var(--mut)">${c.symbol}</span></td>
      <td><b>${fmtMoney(d.price)}</b></td>
      <td class="${up?'up':'down'}">${up?'▲':'▼'} ${d.changePct==null?'—':Math.abs(d.changePct).toFixed(2)+'%'}</td>
      <td class="${(d.change7d||0)>=0?'up':'down'}">${d.change7d==null?'—':((d.change7d>=0?'▲ ':'▼ ')+Math.abs(d.change7d).toFixed(2)+'%')}</td>
      <td>${fmtCompact(d.quoteVolume)}</td><td>${fmtCompact(d.marketCap)}</td>
      <td><canvas class="mini" data-coin="${c.symbol}"></canvas></td></tr>`;
  }).join('');
  document.querySelectorAll('canvas.spark').forEach(cv => {
    const coin = COINS.find(c => c.symbol === cv.dataset.coin);
    const d = state.data[cv.dataset.coin] || {};
    sparkline(cv, d.closes, coin.color, d.changePct);
  });
  document.querySelectorAll('canvas.mini').forEach(cv => {
    const coin = COINS.find(c => c.symbol === cv.dataset.coin);
    const d = state.data[cv.dataset.coin] || {};
    const ctx2 = cv.getContext('2d');
    const W = cv.width = 240, H = cv.height = 64;
    ctx2.clearRect(0,0,W,H);
    const closes = d.closes;
    if (!closes || closes.length < 2) return;
    const min = Math.min(...closes), max = Math.max(...closes), rg = (max-min)||1;
    ctx2.beginPath();
    closes.forEach((v,i)=>{ const x=4+(W-8)*i/(closes.length-1), y=H-6-(H-12)*(v-min)/rg; i?ctx2.lineTo(x,y):ctx2.moveTo(x,y); });
    ctx2.strokeStyle = coin.color; ctx2.lineWidth = 3; ctx2.stroke();
  });
}

function restartCountdown() {
  clearInterval(state.countdown);
  if (!state.interval) { bar.style.width = '0'; return; }
  state.nextAt = Date.now() + state.interval;
  state.countdown = setInterval(() => {
    const left = state.nextAt - Date.now();
    if (left <= 0) { loadAll(); return; }
    bar.style.width = (100 * (1 - left/state.interval)).toFixed(1) + '%';
  }, 250);
}

$('#currency').addEventListener('change', (e) => { state.fiat = e.target.value; loadAll(); });
$('#refreshRate').addEventListener('change', (e) => {
  clearInterval(state.timer);
  state.interval = parseInt(e.target.value, 10);
  if (state.interval) state.timer = setInterval(() => loadAll(), state.interval);
  restartCountdown(); loadAll();
});
refreshBtn.addEventListener('click', () => loadAll(true));
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active'); state.range = t.dataset.range; loadAll();
}));

// cached first paint
try {
  const cached = JSON.parse(localStorage.getItem('cryptopulse-cache') || 'null');
  if (cached && cached.data) { state.data = cached.data; state.fiat = cached.fiat || 'USDT'; $('#currency').value = state.fiat; render(); }
} catch {}
if (!Object.keys(state.data).length) {
  // skeleton
  cardsEl.innerHTML = COINS.map(c => `<article class="card" style="--coin:${c.color}"><div class="coin-head"><div class="icon ${c.cls}">${c.icon}</div><div><h2>${c.name} <small>${c.symbol}</small></h2></div></div><div class="price">…</div><p style="color:var(--mut)">Loading live price…</p></article>`).join('');
}

loadAll();
state.timer = setInterval(() => loadAll(), state.interval);
