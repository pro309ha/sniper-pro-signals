/**
 * BTC/USDT Signal Terminal — script.js
 * ─────────────────────────────────────
 * • Fetches live candle data from Binance via CORS proxy
 * • Calculates EMA50, EMA200 (manual), RSI14 (manual)
 * • Generates STRONG BUY / STRONG SELL / WAIT signals
 * • Auto-updates every 10 seconds
 * • Zero external dependencies
 */

'use strict';

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
const CONFIG = {
  symbol:        'BTCUSDT',
  intervals:     ['5m', '15m'],
  emaFast:       50,
  emaSlow:       200,
  rsiPeriod:     14,
  refreshMs:     10_000,   // 10 seconds
  // Minimum candles needed  = emaSlow + a bit of buffer
  candleLimit:   210,

  // Free CORS proxies (tried in order until one succeeds)
  proxies: [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
  ],

  // Binance REST endpoint
  binanceBase: 'https://api.binance.com/api/v3/klines',
};

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────
let lastPrice = null;
let countdownTimer = null;
let refreshTimer  = null;
let proxyIndex = 0;   // which proxy is currently working

// ──────────────────────────────────────────────
// MATH HELPERS
// ──────────────────────────────────────────────

/**
 * Calculate Exponential Moving Average for a given period.
 * @param {number[]} closes  – array of closing prices, oldest first
 * @param {number}   period  – EMA period
 * @returns {number}         – latest EMA value
 */
function calcEMA(closes, period) {
  if (closes.length < period) return null;

  const k = 2 / (period + 1);

  // Seed with SMA of first `period` candles
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Calculate RSI for a given period.
 * @param {number[]} closes  – array of closing prices, oldest first
 * @param {number}   period  – RSI period (default 14)
 * @returns {number}         – RSI value 0-100
 */
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }

  let avgGain = gains  / period;
  let avgLoss = losses / period;

  // Wilder smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Determine trend direction from two EMA values.
 * @returns {'UP'|'DOWN'|'SIDE'}
 */
function determineTrend(emaFast, emaSlow) {
  if (emaFast === null || emaSlow === null) return 'SIDE';
  const diff = (emaFast - emaSlow) / emaSlow;   // relative difference
  if (diff >  0.0002) return 'UP';
  if (diff < -0.0002) return 'DOWN';
  return 'SIDE';
}

/**
 * Determine RSI zone for confirmation.
 * @returns {'BUY'|'SELL'|'NEUTRAL'}
 */
function rsiConfirmation(rsi) {
  if (rsi === null) return 'NEUTRAL';
  if (rsi >= 52 && rsi <= 68) return 'BUY';
  if (rsi >= 32 && rsi <= 48) return 'SELL';
  return 'NEUTRAL';
}

// ──────────────────────────────────────────────
// DATA FETCHING
// ──────────────────────────────────────────────

/**
 * Build Binance klines URL.
 */
function buildBinanceUrl(interval) {
  return `${CONFIG.binanceBase}?symbol=${CONFIG.symbol}&interval=${interval}&limit=${CONFIG.candleLimit}`;
}

/**
 * Fetch with automatic proxy rotation.
 */
async function fetchWithProxy(rawUrl) {
  // Try each proxy, remembering the last working one
  const attempts = CONFIG.proxies.length;
  for (let i = 0; i < attempts; i++) {
    const idx = (proxyIndex + i) % attempts;
    const proxiedUrl = CONFIG.proxies[idx](rawUrl);
    try {
      const res = await fetch(proxiedUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      proxyIndex = idx;   // remember the working proxy
      return data;
    } catch (err) {
      console.warn(`Proxy ${idx} failed:`, err.message);
    }
  }

  // Last resort: try direct (works in some environments)
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error('All proxies and direct fetch failed.');
  }
}

/**
 * Fetch candle closing prices for a given interval.
 * Binance kline format: [openTime, open, high, low, close, volume, ...]
 */
async function fetchCloses(interval) {
  const raw = await fetchWithProxy(buildBinanceUrl(interval));
  // raw is array of arrays — index 4 is close price
  return raw.map(k => parseFloat(k[4]));
}

// ──────────────────────────────────────────────
// SIGNAL LOGIC
// ──────────────────────────────────────────────

function generateSignal(trend5m, trend15m, rsiZone) {
  const bothUp   = trend5m === 'UP'   && trend15m === 'UP';
  const bothDown = trend5m === 'DOWN' && trend15m === 'DOWN';

  if (bothUp) {
    // Optional RSI confirmation — don't block signal, just note
    const rsiOk = rsiZone === 'BUY' || rsiZone === 'NEUTRAL';
    return {
      signal: 'STRONG BUY',
      type:   'buy',
      emoji:  '🚀',
      desc:   rsiOk
        ? 'Both timeframes confirm UPTREND. RSI supports entry.'
        : 'Both timeframes confirm UPTREND. RSI is elevated — manage risk.',
    };
  }

  if (bothDown) {
    const rsiOk = rsiZone === 'SELL' || rsiZone === 'NEUTRAL';
    return {
      signal: 'STRONG SELL',
      type:   'sell',
      emoji:  '🔻',
      desc:   rsiOk
        ? 'Both timeframes confirm DOWNTREND. RSI supports entry.'
        : 'Both timeframes confirm DOWNTREND. RSI is low — monitor closely.',
    };
  }

  // Mixed or side
  let desc = 'Timeframes are not aligned. Waiting for confirmation.';
  if (trend5m !== trend15m) {
    desc = `5M trend is ${trend5m}, 15M trend is ${trend15m}. No clear confluence.`;
  } else if (trend5m === 'SIDE') {
    desc = 'Market is ranging sideways. No signal.';
  }

  return { signal: 'WAIT', type: 'wait', emoji: '⏳', desc };
}

// ──────────────────────────────────────────────
// UI UPDATES
// ──────────────────────────────────────────────

function fmt(num) {
  if (num === null || isNaN(num)) return '—';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function trendTag(trend) {
  const map = { UP: ['tag-up', '▲ UP'], DOWN: ['tag-down', '▼ DOWN'], SIDE: ['tag-side', '◆ SIDE'] };
  const [cls, label] = map[trend] || ['tag-neutral', '—'];
  return `<span class="tag ${cls}">${label}</span>`;
}

function crossTag(fast, slow) {
  if (fast === null || slow === null) return '<span class="tag tag-neutral">—</span>';
  const diff = (fast - slow).toFixed(2);
  const cls  = fast > slow ? 'tag-up' : (fast < slow ? 'tag-down' : 'tag-side');
  const sign = fast > slow ? '+' : '';
  return `<span class="tag ${cls}">${sign}${diff}</span>`;
}

function confirmTag(trend, rsiZone) {
  if (trend === 'UP'   && (rsiZone === 'BUY'  || rsiZone === 'NEUTRAL')) return '<span class="tag tag-up">✓ YES</span>';
  if (trend === 'DOWN' && (rsiZone === 'SELL' || rsiZone === 'NEUTRAL')) return '<span class="tag tag-down">✓ YES</span>';
  if (trend === 'SIDE') return '<span class="tag tag-neutral">— N/A</span>';
  return '<span class="tag tag-side">⚠ MIXED</span>';
}

function setEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function updateUI(data) {
  const { price, prev, ema50_5m, ema200_5m, ema50_15m, ema200_15m,
          rsi, trend5m, trend15m, signal } = data;

  // Price
  const priceEl = document.getElementById('btc-price');
  if (priceEl) {
    priceEl.classList.remove('shimmer');
    priceEl.textContent = '$' + fmt(price);
    priceEl.style.color = prev !== null
      ? (price > prev ? 'var(--green)' : price < prev ? 'var(--red)' : '#fff')
      : '#fff';
    setTimeout(() => { if (priceEl) priceEl.style.color = '#fff'; }, 800);
  }

  // Change
  if (prev !== null) {
    const chg = price - prev;
    const pct = ((chg / prev) * 100).toFixed(2);
    const sign = chg >= 0 ? '+' : '';
    const col  = chg >= 0 ? 'var(--green)' : 'var(--red)';
    setEl('btc-change', `<span style="color:${col}">${sign}${fmt(chg)} (${sign}${pct}%)</span> from last tick`);
  }

  // Timestamp
  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  setEl('last-updated', `LAST UPDATE: ${now} UTC`);

  // Signal card
  const card = document.getElementById('signal-card');
  if (card) {
    card.className = `signal-card ${signal.type}`;
  }
  const sigEl = document.getElementById('signal-text');
  if (sigEl) {
    sigEl.classList.remove('shimmer');
    sigEl.textContent = `${signal.emoji} ${signal.signal}`;
  }
  setEl('signal-desc', signal.desc);

  // Metric values
  setEl('ema50-5m',   fmt(ema50_5m));
  setEl('ema200-5m',  fmt(ema200_5m));
  setEl('ema50-15m',  fmt(ema50_15m));
  setEl('ema200-15m', fmt(ema200_15m));

  // RSI bar
  const rsiSafe = rsi !== null ? Math.min(100, Math.max(0, rsi)) : 50;
  const rsiPct  = rsiSafe + '%';
  setEl('rsi-value', rsi !== null ? rsiSafe.toFixed(1) : '—');
  const fillEl  = document.getElementById('rsi-fill');
  const thumbEl = document.getElementById('rsi-thumb');
  if (fillEl)  fillEl.style.width  = rsiPct;
  if (thumbEl) thumbEl.style.left  = rsiPct;

  // Timeframe table
  const rsiZone = rsiConfirmation(rsi);
  setEl('trend-5m',   trendTag(trend5m));
  setEl('cross-5m',   crossTag(ema50_5m, ema200_5m));
  setEl('confirm-5m', confirmTag(trend5m, rsiZone));

  setEl('trend-15m',   trendTag(trend15m));
  setEl('cross-15m',   crossTag(ema50_15m, ema200_15m));
  setEl('confirm-15m', confirmTag(trend15m, rsiZone));

  // Hide error
  const errEl = document.getElementById('error-banner');
  if (errEl) errEl.style.display = 'none';
}

function showError(msg) {
  const errEl = document.getElementById('error-banner');
  if (errEl) { errEl.style.display = 'block'; errEl.textContent = `⚠ ${msg}`; }
  console.error('Signal terminal error:', msg);
}

// ──────────────────────────────────────────────
// COUNTDOWN UI
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
  const numEl  = document.getElementById('countdown-num');
  const fillEl = document.getElementById('progress-fill');
  if (numEl)  numEl.textContent = countdownSec + 's';
  if (fillEl) fillEl.style.width = (countdownSec / 10 * 100) + '%';
}

// ──────────────────────────────────────────────
// MAIN REFRESH LOOP
// ──────────────────────────────────────────────

let previousPrice = null;

async function refresh() {
  try {
    // Fetch both timeframes in parallel
    const [closes5m, closes15m] = await Promise.all([
      fetchCloses('5m'),
      fetchCloses('15m'),
    ]);

    // Current price = last close of 5m
    const price = closes5m[closes5m.length - 1];

    // Calculate indicators
    const ema50_5m   = calcEMA(closes5m,  CONFIG.emaFast);
    const ema200_5m  = calcEMA(closes5m,  CONFIG.emaSlow);
    const ema50_15m  = calcEMA(closes15m, CONFIG.emaFast);
    const ema200_15m = calcEMA(closes15m, CONFIG.emaSlow);
    const rsi        = calcRSI(closes5m,  CONFIG.rsiPeriod);

    // Trend detection
    const trend5m  = determineTrend(ema50_5m,  ema200_5m);
    const trend15m = determineTrend(ema50_15m, ema200_15m);

    // RSI zone
    const rsiZone = rsiConfirmation(rsi);

    // Signal
    const signal = generateSignal(trend5m, trend15m, rsiZone);

    updateUI({
      price, prev: previousPrice,
      ema50_5m, ema200_5m, ema50_15m, ema200_15m,
      rsi, trend5m, trend15m, signal,
    });

    previousPrice = price;

  } catch (err) {
    showError(err.message || 'Unable to fetch market data. Retrying…');
  }

  // Reset countdown regardless of success/failure
  startCountdown();
}

// ──────────────────────────────────────────────
// BOOT
// ──────────────────────────────────────────────

(function init() {
  refresh(); // immediate first load
  refreshTimer = setInterval(refresh, CONFIG.refreshMs);
})();

// ──────────────────────────────────────────────
// FUTURE EXTENSION HOOKS
// ──────────────────────────────────────────────

/**
 * GOLD (XAU/USD) Support — placeholder
 * To enable: change CONFIG.symbol to 'XAUUSDT' or add a second asset
 * and call generateSignal for that asset separately.
 *
 * TELEGRAM ALERTS — placeholder
 * async function sendTelegramAlert(signal, price) {
 *   const token = 'YOUR_BOT_TOKEN';
 *   const chat  = 'YOUR_CHAT_ID';
 *   const text  = encodeURIComponent(`BTC Signal: ${signal.signal} @ $${price}`);
 *   await fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${chat}&text=${text}`);
 * }
 *
 * SUPPORT / RESISTANCE (placeholder)
 * function calcSupportResistance(closes, lookback = 20) {
 *   const window = closes.slice(-lookback);
 *   return { support: Math.min(...window), resistance: Math.max(...window) };
 * }
 */
