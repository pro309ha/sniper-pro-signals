/**
 * BTC/USDT Signal Terminal — script.js v3
 * ────────────────────────────────────────
 * Strategy: Try multiple API sources in order.
 * Source 1: Binance directly (works on many mobile browsers / networks)
 * Source 2: Binance via corsproxy.io  — returns raw array
 * Source 3: Binance via allorigins    — wraps in {contents:"[...]"}
 * Source 4: Binance via cors-anywhere (public demo)
 * Source 5: CoinGecko (price only fallback)
 *
 * extractKlines() safely unwraps ANY proxy wrapper format.
 */

'use strict';

/* ──────────── CONFIG ──────────── */
const CFG = {
  symbol:      'BTCUSDT',
  emaFast:     50,
  emaSlow:     200,
  rsiPeriod:   14,
  refreshMs:   10000,
  limit:       210,
};

/* ──────────── STATE ──────────── */
let prevPrice      = null;
let countdownTimer = null;
let lastWorkingIdx = 0;

/* ──────────── API SOURCES ──────────── */
/*
 * Each source has:
 *   url(interval)  – builds the full URL to fetch
 *   unwrap(data)   – extracts klines array from whatever is returned
 */
const SOURCES = [
  /* ① Direct Binance — no CORS header needed on many Android browsers */
  {
    name: 'Binance Direct',
    url:  iv => `https://api.binance.com/api/v3/klines?symbol=${CFG.symbol}&interval=${iv}&limit=${CFG.limit}`,
    unwrap: d => Array.isArray(d) ? d : null,
  },
  /* ② Binance US mirror — different domain, sometimes less restrictive */
  {
    name: 'Binance US',
    url:  iv => `https://api.binance.us/api/v3/klines?symbol=${CFG.symbol}&interval=${iv}&limit=${CFG.limit}`,
    unwrap: d => Array.isArray(d) ? d : null,
  },
  /* ③ corsproxy.io — returns JSON as-is */
  {
    name: 'corsproxy.io',
    url:  iv => `https://corsproxy.io/?${encodeURIComponent(`https://api.binance.com/api/v3/klines?symbol=${CFG.symbol}&interval=${iv}&limit=${CFG.limit}`)}`,
    unwrap: d => Array.isArray(d) ? d : null,
  },
  /* ④ allorigins /get — wraps body in { contents: "..." } */
  {
    name: 'allorigins /get',
    url:  iv => `https://api.allorigins.win/get?url=${encodeURIComponent(`https://api.binance.com/api/v3/klines?symbol=${CFG.symbol}&interval=${iv}&limit=${CFG.limit}`)}`,
    unwrap: d => {
      try {
        if (d && typeof d.contents === 'string') {
          const p = JSON.parse(d.contents);
          return Array.isArray(p) ? p : null;
        }
      } catch (_) {}
      return null;
    },
  },
  /* ⑤ allorigins /raw — returns raw text of JSON */
  {
    name: 'allorigins /raw',
    url:  iv => `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://api.binance.com/api/v3/klines?symbol=${CFG.symbol}&interval=${iv}&limit=${CFG.limit}`)}`,
    unwrap: d => Array.isArray(d) ? d : null,
  },
  /* ⑥ htmldriven cors-anywhere public demo */
  {
    name: 'cors-anywhere',
    url:  iv => `https://cors-anywhere.herokuapp.com/https://api.binance.com/api/v3/klines?symbol=${CFG.symbol}&interval=${iv}&limit=${CFG.limit}`,
    unwrap: d => Array.isArray(d) ? d : null,
  },
];

/* ──────────── FETCH ONE INTERVAL ──────────── */
async function fetchCloses(interval) {
  // Try sources starting from the last one that worked
  for (let i = 0; i < SOURCES.length; i++) {
    const idx = (lastWorkingIdx + i) % SOURCES.length;
    const src = SOURCES[idx];
    try {
      const res = await fetch(src.url(interval), {
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Parse response text → JSON (handles plain text JSON from some proxies)
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch (_) { throw new Error('Non-JSON response'); }

      // Unwrap proxy envelope
      const klines = src.unwrap(json);
      if (!klines || !Array.isArray(klines) || klines.length < 20) {
        throw new Error(`Bad klines (got ${klines ? klines.length : 0})`);
      }

      // Validate first row looks like a Binance kline [timestamp, o, h, l, close, ...]
      if (!Array.isArray(klines[0]) || klines[0][4] === undefined) {
        throw new Error('Unexpected kline row format');
      }

      lastWorkingIdx = idx;
      console.log(`[BTC Signal] ✓ ${src.name} → ${klines.length} candles (${interval})`);
      return klines.map(k => parseFloat(k[4]));

    } catch (err) {
      console.warn(`[BTC Signal] ✗ ${src.name} (${interval}): ${err.message}`);
    }
  }
  throw new Error('All data sources failed for ' + interval);
}

/* ──────────── INDICATORS (manual) ──────────── */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function trend(fast, slow) {
  if (fast == null || slow == null) return 'SIDE';
  const r = (fast - slow) / slow;
  if (r >  0.0002) return 'UP';
  if (r < -0.0002) return 'DOWN';
  return 'SIDE';
}

function rsiZone(rsi) {
  if (rsi == null) return 'NEUTRAL';
  if (rsi >= 52 && rsi <= 68) return 'BUY';
  if (rsi >= 32 && rsi <= 48) return 'SELL';
  return 'NEUTRAL';
}

/* ──────────── SIGNAL ──────────── */
function signal(t5, t15, rz) {
  if (t5 === 'UP' && t15 === 'UP') return {
    label: 'STRONG BUY', cls: 'buy', emoji: '🚀',
    desc: (rz === 'BUY' || rz === 'NEUTRAL')
      ? 'Both timeframes UPTREND confirmed. RSI supports entry.'
      : 'Both timeframes UPTREND confirmed. RSI elevated — size carefully.',
  };
  if (t5 === 'DOWN' && t15 === 'DOWN') return {
    label: 'STRONG SELL', cls: 'sell', emoji: '🔻',
    desc: (rz === 'SELL' || rz === 'NEUTRAL')
      ? 'Both timeframes DOWNTREND confirmed. RSI supports entry.'
      : 'Both timeframes DOWNTREND confirmed. RSI low — monitor closely.',
  };
  const desc = t5 !== t15
    ? `5M: ${t5} vs 15M: ${t15} — no confluence yet.`
    : 'Market ranging sideways. Waiting for breakout.';
  return { label: 'WAIT', cls: 'wait', emoji: '⏳', desc };
}

/* ──────────── UI HELPERS ──────────── */
const $ = id => document.getElementById(id);
const set = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };
const fmt = n => (n == null || isNaN(n)) ? '—'
  : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function trendBadge(t) {
  const m = { UP: ['bu','▲ UP'], DOWN: ['bd','▼ DOWN'], SIDE: ['by','◆ SIDE'] };
  const [c, l] = m[t] || ['bn', '—'];
  return `<span class="badge ${c}">${l}</span>`;
}
function crossBadge(f, s) {
  if (f == null || s == null) return '<span class="badge bn">—</span>';
  const d = (f - s).toFixed(2), c = f > s ? 'bu' : f < s ? 'bd' : 'by';
  return `<span class="badge ${c}">${f > s ? '+' : ''}${d}</span>`;
}
function confirmBadge(t, rz) {
  if (t === 'UP'   && (rz === 'BUY'  || rz === 'NEUTRAL')) return '<span class="badge bu">✓ YES</span>';
  if (t === 'DOWN' && (rz === 'SELL' || rz === 'NEUTRAL')) return '<span class="badge bd">✓ YES</span>';
  if (t === 'SIDE') return '<span class="badge bn">— N/A</span>';
  return '<span class="badge by">⚠ MIXED</span>';
}

/* ──────────── MAIN UPDATE ──────────── */
function render(d) {
  // Price
  const pe = $('btc-price');
  if (pe) {
    pe.classList.remove('shimmer');
    pe.textContent = '$' + fmt(d.price);
    if (d.prev != null) {
      pe.style.color = d.price > d.prev ? 'var(--g)' : d.price < d.prev ? 'var(--r)' : '#fff';
      setTimeout(() => { if (pe) pe.style.color = '#fff'; }, 700);
    }
  }
  if (d.prev != null) {
    const ch = d.price - d.prev, pct = ((ch / d.prev) * 100).toFixed(4);
    const col = ch >= 0 ? 'var(--g)' : 'var(--r)';
    set('btc-change', `<span style="color:${col}">${ch >= 0 ? '+' : ''}${fmt(ch)} (${ch >= 0 ? '+' : ''}${pct}%)</span> from last tick`);
  }
  set('last-updated', 'LAST UPDATE: ' + new Date().toLocaleTimeString('en-US', { hour12: false }));

  // Signal card
  const card = $('signal-card');
  if (card) card.className = 'signal-card ' + d.sig.cls;
  const se = $('signal-text');
  if (se) { se.classList.remove('shimmer'); se.textContent = d.sig.emoji + ' ' + d.sig.label; }
  set('signal-desc', d.sig.desc);

  // EMA values
  set('ema50-5m',   fmt(d.e50_5));
  set('ema200-5m',  fmt(d.e200_5));
  set('ema50-15m',  fmt(d.e50_15));
  set('ema200-15m', fmt(d.e200_15));

  // RSI bar
  const rv = d.rsi != null ? Math.min(100, Math.max(0, d.rsi)) : 50;
  set('rsi-value', d.rsi != null ? rv.toFixed(1) : '—');
  const rf = $('rsi-fill'), rt = $('rsi-thumb');
  if (rf) rf.style.width = rv + '%';
  if (rt) rt.style.left  = rv + '%';

  // Table
  const rz = rsiZone(d.rsi);
  set('trend-5m',    trendBadge(d.t5));
  set('cross-5m',    crossBadge(d.e50_5,  d.e200_5));
  set('confirm-5m',  confirmBadge(d.t5,  rz));
  set('trend-15m',   trendBadge(d.t15));
  set('cross-15m',   crossBadge(d.e50_15, d.e200_15));
  set('confirm-15m', confirmBadge(d.t15, rz));

  const eb = $('error-banner');
  if (eb) eb.style.display = 'none';
}

function showErr(msg) {
  const eb = $('error-banner');
  if (eb) { eb.style.display = 'block'; eb.textContent = '⚠ ' + msg; }
  console.error('[BTC Signal]', msg);
}

/* ──────────── COUNTDOWN ──────────── */
let cdSec = 10;
function startCountdown() {
  cdSec = 10; clearInterval(countdownTimer); tick();
  countdownTimer = setInterval(tick, 1000);
}
function tick() {
  cdSec = Math.max(0, cdSec - 1);
  const n = $('countdown-num'), f = $('progress-fill');
  if (n) n.textContent = cdSec + 's';
  if (f) f.style.width = (cdSec / 10 * 100) + '%';
}

/* ──────────── REFRESH ──────────── */
async function refresh() {
  try {
    const [c5, c15] = await Promise.all([fetchCloses('5m'), fetchCloses('15m')]);

    const price   = c5[c5.length - 1];
    const e50_5   = calcEMA(c5,  CFG.emaFast);
    const e200_5  = calcEMA(c5,  CFG.emaSlow);
    const e50_15  = calcEMA(c15, CFG.emaFast);
    const e200_15 = calcEMA(c15, CFG.emaSlow);
    const rsi     = calcRSI(c5,  CFG.rsiPeriod);
    const t5      = trend(e50_5,  e200_5);
    const t15     = trend(e50_15, e200_15);
    const rz      = rsiZone(rsi);
    const sig     = signal(t5, t15, rz);

    render({ price, prev: prevPrice, e50_5, e200_5, e50_15, e200_15, rsi, t5, t15, sig });
    prevPrice = price;
  } catch (err) {
    showErr(err.message || 'Data fetch failed. Retrying…');
  }
  startCountdown();
}

/* ──────────── BOOT ──────────── */
refresh();
setInterval(refresh, CFG.refreshMs);
      
