/**
 * BTC/USDT Signal Terminal — script.js
 * ─────────────────────────────────────
 * FIX: Robust proxy response parsing — handles all proxy wrapper formats
 *      (plain array, allorigins {contents}, etc.)
 */

'use strict';

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
const CONFIG = {
  symbol:      'BTCUSDT',
  emaFast:     50,
  emaSlow:     200,
  rsiPeriod:   14,
  refreshMs:   10000,
  candleLimit: 210,
};

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────
let previousPrice  = null;
let countdownTimer = null;
let proxyIndex     = 0;

// ──────────────────────────────────────────────
// PROXY LIST — each has build() and parse()
// parse() extracts the klines array from whatever the proxy wraps it in
// ──────────────────────────────────────────────
const PROXIES = [
  {
    name:  'corsproxy.io',
    build: url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    parse: data => Array.isArray(data) ? data : null,
  },
  {
    name:  'allorigins (get)',
    build: url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    parse: data => {
      // allorigins wraps: { contents: "[...]", status: {...} }
      try {
        if (data && typeof data.contents === 'string') {
          const inner = JSON.parse(data.contents);
          if (Array.isArray(inner)) return inner;
        }
        if (data && Array.isArray(data.contents)) return data.contents;
      } catch (_) {}
      return null;
    },
  },
  {
    name:  'allorigins (raw)',
    build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    parse: data => Array.isArray(data) ? data : null,
  },
  {
    name:  'thingproxy',
    build: url => `https://thingproxy.freeboard.io/fetch/${url}`,
    parse: data => Array.isArray(data) ? data : null,
  },
  {
    name:  'direct (no proxy)',
    build: url => url,
    parse: data => Array.isArray(data) ? data : null,
  },
];

// ──────────────────────────────────────────────
// SAFE ARRAY EXTRACTOR
// Handles any wrapper a proxy might add
// ──────────────────────────────────────────────
function extractArray(raw) {
  if (Array.isArray(raw)) return raw;

  if (raw && typeof raw === 'object') {
    // allorigins: { contents: "[...]" }
    if (typeof raw.contents === 'string') {
      try { const p = JSON.parse(raw.contents); if (Array.isArray(p)) return p; } catch (_) {}
    }
    if (Array.isArray(raw.contents)) return raw.contents;
    if (Array.isArray(raw.data))     return raw.data;
    if (Array.isArray(raw.result))   return raw.result;
  }

  // Some proxies return a JSON string in the body
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } catch (_) {}
  }

  return null;
}

// ──────────────────────────────────────────────
// FETCH WITH PROXY ROTATION
// ──────────────────────────────────────────────
function buildBinanceUrl(interval) {
  return (
    `https://api.binance.com/api/v3/klines` +
    `?symbol=${CONFIG.symbol}&interval=${interval}&limit=${CONFIG.candleLimit}`
  );
}

async function fetchWithProxy(rawUrl) {
  for (let attempt = 0; attempt < PROXIES.length; attempt++) {
    const idx   = (proxyIndex + attempt) % PROXIES.length;
    const proxy = PROXIES[idx];

    try {
      const res = await fetch(proxy.build(rawUrl), {
        signal: AbortSignal.timeout(9000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (_) { throw new Error('Response is not valid JSON'); }

      const arr = extractArray(parsed);
      if (!arr || arr.length === 0) throw new Error('Could not extract klines array');

      // Sanity-check: first kline should have index [4] = close price string
      if (arr[0] == null || arr[0][4] === undefined) throw new Error('Unexpected kline format');

      proxyIndex = idx; // remember working proxy
      console.log(`[Signal] Using proxy: ${proxy.name}`);
      return arr;

    } catch (err) {
      console.warn(`[Signal] Proxy "${proxy.name}" failed:`, err.message);
    }
  }

  throw new Error('All proxies failed. Check internet connection.');
}

async function fetchCloses(interval) {
  const klines = await fetchWithProxy(buildBinanceUrl(interval));
  return klines.map(k => parseFloat(k[4]));
}

// ──────────────────────────────────────────────
// TECHNICAL INDICATORS (manual — no libraries)
// ──────────────────────────────────────────────

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed: SMA of first `period` values
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function determineTrend(emaFast, emaSlow) {
  if (emaFast === null || emaSlow === null) return 'SIDE';
  const rel = (emaFast - emaSlow) / emaSlow;
  if (rel >  0.0002) return 'UP';
  if (rel < -0.0002) return 'DOWN';
  return 'SIDE';
}

function rsiConfirmation(rsi) {
  if (rsi === null) return 'NEUTRAL';
  if (rsi >= 52 && rsi <= 68) return 'BUY';
  if (rsi >= 32 && rsi <= 48) return 'SELL';
  return 'NEUTRAL';
}

// ──────────────────────────────────────────────
// SIGNAL GENERATION
// ──────────────────────────────────────────────

function generateSignal(trend5m, trend15m, rsiZone) {
  if (trend5m === 'UP' && trend15m === 'UP') {
    return {
      signal: 'STRONG BUY', type: 'buy', emoji: '🚀',
      desc: (rsiZone === 'BUY' || rsiZone === 'NEUTRAL')
        ? 'Both timeframes confirm UPTREND. RSI supports entry.'
        : 'Both timeframes confirm UPTREND. RSI elevated — manage risk.',
    };
  }
  if (trend5m === 'DOWN' && trend15m === 'DOWN') {
    return {
      signal: 'STRONG SELL', type: 'sell', emoji: '🔻',
      desc: (rsiZone === 'SELL' || rsiZone === 'NEUTRAL')
        ? 'Both timeframes confirm DOWNTREND. RSI supports entry.'
        : 'Both timeframes confirm DOWNTREND. RSI low — monitor closely.',
    };
  }
  let desc = 'Timeframes not aligned. Waiting for confirmation.';
  if (trend5m === 'SIDE' && trend15m === 'SIDE') desc = 'Market ranging sideways on both timeframes.';
  else if (trend5m !== trend15m) desc = `5M is ${trend5m}, 15M is ${trend15m}. No clear confluence.`;
  return { signal: 'WAIT', type: 'wait', emoji: '⏳', desc };
}

// ──────────────────────────────────────────────
// UI
// ──────────────────────────────────────────────

function fmt(num) {
  if (num == null || isNaN(num)) return '—';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function trendTag(t) {
  const m = { UP: ['tag-up','▲ UP'], DOWN: ['tag-down','▼ DOWN'], SIDE: ['tag-side','◆ SIDE'] };
  const [c, l] = m[t] || ['tag-neutral','—'];
  return `<span class="tag ${c}">${l}</span>`;
}

function crossTag(fast, slow) {
  if (fast == null || slow == null) return '<span class="tag tag-neutral">—</span>';
  const diff = (fast - slow).toFixed(2);
  const cls  = fast > slow ? 'tag-up' : fast < slow ? 'tag-down' : 'tag-side';
  return `<span class="tag ${cls}">${fast > slow ? '+' : ''}${diff}</span>`;
}

function confirmTag(trend, rsiZone) {
  if (trend === 'UP'   && (rsiZone === 'BUY'  || rsiZone === 'NEUTRAL')) return '<span class="tag tag-up">✓ YES</span>';
  if (trend === 'DOWN' && (rsiZone === 'SELL' || rsiZone === 'NEUTRAL')) return '<span class="tag tag-down">✓ YES</span>';
  if (trend === 'SIDE') return '<span class="tag tag-neutral">— N/A</span>';
  return '<span class="tag tag-side">⚠ MIXED</span>';
}

function updateUI(d) {
  // Price
  const priceEl = document.getElementById('btc-price');
  if (priceEl) {
    priceEl.classList.remove('shimmer');
    priceEl.textContent = '$' + fmt(d.price);
    if (d.prev !== null) {
      priceEl.style.color = d.price > d.prev ? 'var(--green)' : d.price < d.prev ? 'var(--red)' : '#fff';
      setTimeout(() => { if (priceEl) priceEl.style.color = '#fff'; }, 800);
    }
  }

  if (d.prev !== null) {
    const chg = d.price - d.prev;
    const pct = ((chg / d.prev) * 100).toFixed(4);
    const col = chg >= 0 ? 'var(--green)' : 'var(--red)';
    setEl('btc-change', `<span style="color:${col}">${chg >= 0 ? '+' : ''}${fmt(chg)} (${chg >= 0 ? '+' : ''}${pct}%)</span> from last tick`);
  }

  setEl('last-updated', `LAST UPDATE: ${new Date().toLocaleTimeString('en-US', { hour12: false })}`);

  // Signal card
  const card = document.getElementById('signal-card');
  if (card) card.className = `signal-card ${d.signal.type}`;
  const sigEl = document.getElementById('signal-text');
  if (sigEl) { sigEl.classList.remove('shimmer'); sigEl.textContent = `${d.signal.emoji} ${d.signal.signal}`; }
  setEl('signal-desc', d.signal.desc);

  // EMA values
  setEl('ema50-5m',   fmt(d.ema50_5m));
  setEl('ema200-5m',  fmt(d.ema200_5m));
  setEl('ema50-15m',  fmt(d.ema50_15m));
  setEl('ema200-15m', fmt(d.ema200_15m));

  // RSI bar
  const rsiSafe = d.rsi !== null ? Math.min(100, Math.max(0, d.rsi)) : 50;
  setEl('rsi-value', d.rsi !== null ? rsiSafe.toFixed(1) : '—');
  const rsiPct = rsiSafe + '%';
  const fillEl  = document.getElementById('rsi-fill');
  const thumbEl = document.getElementById('rsi-thumb');
  if (fillEl)  fillEl.style.width = rsiPct;
  if (thumbEl) thumbEl.style.left = rsiPct;

  // Table
  const rsiZone = rsiConfirmation(d.rsi);
  setEl('trend-5m',    trendTag(d.trend5m));
  setEl('cross-5m',    crossTag(d.ema50_5m, d.ema200_5m));
  setEl('confirm-5m',  confirmTag(d.trend5m, rsiZone));
  setEl('trend-15m',   trendTag(d.trend15m));
  setEl('cross-15m',   crossTag(d.ema50_15m, d.ema200_15m));
  setEl('confirm-15m', confirmTag(d.trend15m, rsiZone));

  const errEl = document.getElementById('error-banner');
  if (errEl) errEl.style.display = 'none';
}

function showError(msg) {
  const errEl = document.getElementById('error-banner');
  if (errEl) { errEl.style.display = 'block'; errEl.textContent = `⚠ ${msg}`; }
  console.error('[Signal Terminal]', msg);
}

// ──────────────────────────────────────────────
// COUNTDOWN
// ──────────────────────────────────────────────
let countdownSec = 10;

function startCountdown() {
  countdownSec = 10;
  clearInterval(countdownTimer);
  updateCountdownUI();
  countdownTimer = setInterval(() => {
    countdownSec = Math.max(0, countdownSec - 1);
    updateCountdownUI();
  }, 1000);
}

function updateCountdownUI() {
  const n = document.getElementById('countdown-num');
  const f = document.getElementById('progress-fill');
  if (n) n.textContent  = countdownSec + 's';
  if (f) f.style.width  = (countdownSec / 10 * 100) + '%';
}

// ──────────────────────────────────────────────
// MAIN REFRESH
// ──────────────────────────────────────────────
async function refresh() {
  try {
    const [closes5m, closes15m] = await Promise.all([
      fetchCloses('5m'),
      fetchCloses('15m'),
    ]);

    const price      = closes5m[closes5m.length - 1];
    const ema50_5m   = calcEMA(closes5m,  CONFIG.emaFast);
    const ema200_5m  = calcEMA(closes5m,  CONFIG.emaSlow);
    const ema50_15m  = calcEMA(closes15m, CONFIG.emaFast);
    const ema200_15m = calcEMA(closes15m, CONFIG.emaSlow);
    const rsi        = calcRSI(closes5m,  CONFIG.rsiPeriod);
    const trend5m    = determineTrend(ema50_5m,  ema200_5m);
    const trend15m   = determineTrend(ema50_15m, ema200_15m);
    const rsiZone    = rsiConfirmation(rsi);
    const signal     = generateSignal(trend5m, trend15m, rsiZone);

    updateUI({ price, prev: previousPrice, ema50_5m, ema200_5m, ema50_15m, ema200_15m, rsi, trend5m, trend15m, signal });
    previousPrice = price;

  } catch (err) {
    showError(err.message || 'Unable to fetch market data. Retrying…');
  }
  startCountdown();
}

// ──────────────────────────────────────────────
// BOOT
// ──────────────────────────────────────────────
(function init() {
  refresh();
  setInterval(refresh, CONFIG.refreshMs);
})();

// ── Future hooks ────────────────────────────────
// Gold: CONFIG.symbol = 'XAUUSDT'
// Telegram: fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=${CHAT}&text=${msg}`)
// S/R: closes.slice(-20) → Math.min/max
      
