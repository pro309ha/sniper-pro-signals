/**
 * SNIPER PRO — script.js
 * ══════════════════════════════════════════════════════
 * BTC/USDT signal terminal with EMA50/200 + RSI14
 * Data sources (tried in order, all have open CORS):
 *   1. Bybit  v5  REST  — api.bybit.com
 *   2. OKX    v5  REST  — www.okx.com
 *   3. KuCoin v1  REST  — api.kucoin.com
 * Price overlay: CoinGecko simple/price (24h change)
 *
 * No external libraries. Pure vanilla JS.
 * ══════════════════════════════════════════════════════
 */

'use strict';

/* ──────────────────────────────────────────────────────
   CONFIG
   Change SYMBOL/GOLD_SYMBOL here for future instruments.
   ────────────────────────────────────────────────────── */
const CFG = {
  SYMBOL:      'BTCUSDT',    // base trading pair (Bybit/OKX format)
  SYMBOL_KC:   'BTC-USDT',   // KuCoin format
  CG_ID:       'bitcoin',    // CoinGecko coin id
  EMA_FAST:    50,
  EMA_SLOW:    200,
  RSI_PERIOD:  14,
  CANDLE_LIMIT:220,          // must be > EMA_SLOW + buffer
  REFRESH_MS:  10000,        // 10 seconds
};

/* ──────────────────────────────────────────────────────
   FUTURE HOOKS (Gold / XAU support stub)
   Swap CFG values and call refresh() to switch symbol.
   ────────────────────────────────────────────────────── */
// const GOLD_CFG = { SYMBOL:'XAUUSDT', SYMBOL_KC:'XAU-USDT', CG_ID:'gold', ... };

/* ──────────────────────────────────────────────────────
   FUTURE HOOK — Telegram alert stub
   Fill BOT_TOKEN + CHAT_ID and call sendTelegram().
   ────────────────────────────────────────────────────── */
// const TG = { BOT_TOKEN: '', CHAT_ID: '' };
// async function sendTelegram(msg) {
//   if (!TG.BOT_TOKEN) return;
//   const url = `https://api.telegram.org/bot${TG.BOT_TOKEN}/sendMessage`
//             + `?chat_id=${TG.CHAT_ID}&text=${encodeURIComponent(msg)}`;
//   await fetch(url).catch(()=>{});
// }

/* ──────────────────────────────────────────────────────
   STATE
   ────────────────────────────────────────────────────── */
let prevPrice    = null;
let cdSec        = 10;
let cdTimer      = null;
let refreshTimer = null;
let lastSrcName  = '—';

/* ══════════════════════════════════════════════════════
   INDICATOR MATH  (zero dependencies)
══════════════════════════════════════════════════════ */

/**
 * Exponential Moving Average
 * Seeds with SMA of first `period` values, then applies
 * Wilder/EMA smoothing for the remainder.
 * @param {number[]} closes - oldest-first array
 * @param {number}   period
 * @returns {number|null}
 */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed: simple average of first `period` candles
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  // Smooth remaining values
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Relative Strength Index (Wilder smoothing)
 * @param {number[]} closes - oldest-first array
 * @param {number}   period
 * @returns {number|null}
 */
function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  // Initial period
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Wilder smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Trend direction from two EMA values.
 * Uses a tiny relative threshold (0.02%) to avoid SIDE on noise.
 * @returns {'UP'|'DOWN'|'SIDE'}
 */
function getTrend(emaFast, emaSlow) {
  if (emaFast == null || emaSlow == null) return 'SIDE';
  const rel = (emaFast - emaSlow) / emaSlow;
  if (rel >  0.0002) return 'UP';
  if (rel < -0.0002) return 'DOWN';
  return 'SIDE';
}

/**
 * RSI zone for optional confirmation.
 * @returns {'BUY'|'SELL'|'NEUTRAL'}
 */
function getRsiZone(rsi) {
  if (rsi == null) return 'NEUTRAL';
  if (rsi >= 52 && rsi <= 68) return 'BUY';
  if (rsi >= 32 && rsi <= 48) return 'SELL';
  return 'NEUTRAL';
}

/**
 * Generate the trading signal from both timeframe trends + RSI.
 * Core rule: ONLY fire when BOTH timeframes agree.
 * RSI provides an extra-confidence note but doesn't block the signal.
 */
function generateSignal(trend5m, trend15m, rsiZone) {
  if (trend5m === 'UP' && trend15m === 'UP') {
    const rsiOk = rsiZone === 'BUY' || rsiZone === 'NEUTRAL';
    return {
      type:  'buy',
      label: 'STRONG BUY',
      emoji: '🚀',
      desc:  rsiOk
        ? 'Both timeframes confirm UPTREND. RSI in buy zone. Entry confirmed.'
        : 'Both timeframes confirm UPTREND. RSI elevated — size position carefully.',
    };
  }
  if (trend5m === 'DOWN' && trend15m === 'DOWN') {
    const rsiOk = rsiZone === 'SELL' || rsiZone === 'NEUTRAL';
    return {
      type:  'sell',
      label: 'STRONG SELL',
      emoji: '🔻',
      desc:  rsiOk
        ? 'Both timeframes confirm DOWNTREND. RSI in sell zone. Entry confirmed.'
        : 'Both timeframes confirm DOWNTREND. RSI low — monitor for reversal.',
    };
  }
  // Mixed or sideways
  if (trend5m !== trend15m && trend5m !== 'SIDE' && trend15m !== 'SIDE') {
    return {
      type:  'wait',
      label: 'WAIT',
      emoji: '⏳',
      desc:  `Conflicting signals — 5M is ${trend5m}, 15M is ${trend15m}. No entry.`,
    };
  }
  return {
    type:  'wait',
    label: 'WAIT',
    emoji: '⏳',
    desc:  'Market ranging sideways. Waiting for trend confirmation.',
  };
}

/* ══════════════════════════════════════════════════════
   DATA SOURCES
   All three APIs have open Access-Control-Allow-Origin: *
   headers — no proxy needed, works from any browser.
══════════════════════════════════════════════════════ */

/**
 * Bybit v5 /market/kline
 * interval: '5' = 5 min, '15' = 15 min
 * Response: { result:{ list:[ [startTime,o,h,l,close,vol,turnover], ... ] } }
 * List is NEWEST-FIRST → must reverse.
 */
async function fetchBybit(intervalMin) {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${CFG.SYMBOL}&interval=${intervalMin}&limit=${CFG.CANDLE_LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
  const j = await res.json();
  if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
  const list = j.result && j.result.list;
  if (!Array.isArray(list) || list.length < 20) throw new Error('Bybit: insufficient data');
  // index 4 = close price; list is newest-first
  return list.map(k => parseFloat(k[4])).reverse();
}

/**
 * OKX v5 /market/candles
 * bar: '5m', '15m'
 * Response: { data:[ [ts,o,h,l,close,vol,volCcy,volCcyQuote,confirm], ... ] }
 * Data is NEWEST-FIRST → must reverse.
 */
async function fetchOKX(intervalMin) {
  const bar = intervalMin + 'm';
  const url = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=${CFG.CANDLE_LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== '0') throw new Error(`OKX: ${j.msg}`);
  const data = j.data;
  if (!Array.isArray(data) || data.length < 20) throw new Error('OKX: insufficient data');
  // index 4 = close; data is newest-first
  return data.map(k => parseFloat(k[4])).reverse();
}

/**
 * KuCoin v1 /market/candles
 * type: '5min', '15min'
 * Response: { data:[ [ts,open,close,high,low,volume,amount], ... ] }
 * NOTE: KuCoin index 2 = CLOSE (not index 4!)
 * Data is NEWEST-FIRST → must reverse.
 */
async function fetchKuCoin(intervalMin) {
  const typeStr = intervalMin + 'min';
  const now  = Math.floor(Date.now() / 1000);
  const from = now - parseInt(intervalMin) * 60 * (CFG.CANDLE_LIMIT + 10);
  const url  = `https://api.kucoin.com/api/v1/market/candles?type=${typeStr}&symbol=${CFG.SYMBOL_KC}&startAt=${from}&endAt=${now}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`KuCoin HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== '200000') throw new Error(`KuCoin: ${j.msg}`);
  const data = j.data;
  if (!Array.isArray(data) || data.length < 20) throw new Error('KuCoin: insufficient data');
  // KuCoin: index 2 = close; newest-first
  return data.map(k => parseFloat(k[2])).reverse();
}

/**
 * Try all three data sources for a given interval.
 * Returns closes array (oldest-first) from whichever succeeds first.
 */
async function fetchCloses(intervalMin) {
  const sources = [
    { name: 'Bybit',  fn: () => fetchBybit(intervalMin) },
    { name: 'OKX',    fn: () => fetchOKX(intervalMin) },
    { name: 'KuCoin', fn: () => fetchKuCoin(intervalMin) },
  ];
  const errors = [];
  for (const src of sources) {
    try {
      const closes = await src.fn();
      // Sanity check: all values must be finite positive numbers
      if (!closes.every(v => isFinite(v) && v > 0)) throw new Error('Invalid price values');
      lastSrcName = src.name;
      return closes;
    } catch (err) {
      console.warn(`[Signal] ${src.name} (${intervalMin}m) failed:`, err.message);
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  throw new Error('All sources failed for ' + intervalMin + 'm — ' + errors.join(' | '));
}

/**
 * CoinGecko simple price — for live price + 24h change overlay.
 * Falls back gracefully if unavailable.
 */
async function fetchCoinGeckoPrice() {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${CFG.CG_ID}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = await res.json();
  const coin = j[CFG.CG_ID];
  if (!coin) throw new Error('CoinGecko: no data');
  return { price: coin.usd, change24h: coin.usd_24h_change };
}

/* ══════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════ */

const $   = id => document.getElementById(id);
const set = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };

/** Format a price number with commas, 2 decimal places */
function fmtPrice(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a small EMA value (same as price but shorter for mini labels) */
function fmtShort(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/** Trend HTML badge */
function trendBadge(trend) {
  const map = {
    UP:   ['b-up',   '▲ UP'],
    DOWN: ['b-down', '▼ DOWN'],
    SIDE: ['b-side', '◆ SIDE'],
  };
  const [cls, lbl] = map[trend] || ['b-na', '—'];
  return `<span class="tr-badge ${cls}">${lbl}</span>`;
}

/** Inline badge for table cells */
function cellBadge(cls, text) {
  const colors = {
    green:  'color:var(--green)',
    red:    'color:var(--red)',
    yellow: 'color:var(--yellow)',
    dim:    'color:var(--text3)',
  };
  return `<span style="${colors[cls]||''};font-weight:700">${text}</span>`;
}

/** Update the RSI visual bar and thumb */
function updateRsiBar(rsiVal) {
  const safe = rsiVal != null ? Math.min(100, Math.max(0, rsiVal)) : 50;
  const pct  = safe + '%';
  const fill  = $('rsi-fill');
  const thumb = $('rsi-thumb');
  if (fill)  fill.style.width = pct;
  if (thumb) thumb.style.left  = pct;
}

/** Determine RSI zone label and color for display */
function rsiZoneDisplay(rsiZone, rsiVal) {
  if (rsiVal == null) return { lbl: '—', style: '' };
  if (rsiZone === 'BUY')  return { lbl: `RSI ${rsiVal.toFixed(1)} · BUY ZONE`,  style: 'color:var(--green)' };
  if (rsiZone === 'SELL') return { lbl: `RSI ${rsiVal.toFixed(1)} · SELL ZONE`, style: 'color:var(--red)' };
  if (rsiVal > 70)        return { lbl: `RSI ${rsiVal.toFixed(1)} · OVERBOUGHT`, style: 'color:var(--yellow)' };
  if (rsiVal < 30)        return { lbl: `RSI ${rsiVal.toFixed(1)} · OVERSOLD`,   style: 'color:var(--yellow)' };
  return { lbl: `RSI ${rsiVal.toFixed(1)} · NEUTRAL`, style: 'color:var(--text2)' };
}

/** Show / hide error banner */
function showError(msg) {
  const el = $('error-box');
  if (el) { el.style.display = 'block'; el.textContent = '⚠ ' + msg; }
}
function hideError() {
  const el = $('error-box'); if (el) el.style.display = 'none';
}

/* ══════════════════════════════════════════════════════
   MAIN RENDER
══════════════════════════════════════════════════════ */
function render(data) {
  const {
    price, change24h,
    e50_5, e200_5, e50_15, e200_15,
    rsiVal, trend5m, trend15m, signal,
  } = data;

  // ── Price display ──
  const priceEl = $('btc-price');
  if (priceEl) {
    priceEl.classList.remove('shim');
    priceEl.textContent = '$' + fmtPrice(price);
    if (prevPrice !== null) {
      priceEl.classList.toggle('up',   price > prevPrice);
      priceEl.classList.toggle('down', price < prevPrice);
      setTimeout(() => {
        priceEl.classList.remove('up', 'down');
      }, 700);
    }
  }

  // 24h change
  if (change24h != null && isFinite(change24h)) {
    const sign = change24h >= 0 ? '+' : '';
    const cls  = change24h >= 0 ? 'up' : 'down';
    set('btc-change', `<span class="${cls}">${sign}${change24h.toFixed(2)}% 24h</span>`);
  }

  // Timestamp + source
  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  set('last-updated', `UPDATED ${now}`);
  set('src-tag', `SRC: ${lastSrcName}`);

  // ── Signal card ──
  const card = $('signal-card');
  if (card) card.className = 'sig-card ' + signal.type;

  const sigTextEl = $('signal-text');
  if (sigTextEl) {
    sigTextEl.classList.remove('shim');
    sigTextEl.textContent = signal.emoji + ' ' + signal.label;
  }
  set('signal-desc', signal.desc);

  // ── RSI ──
  const rsiZone = getRsiZone(rsiVal);
  updateRsiBar(rsiVal);
  set('rsi-number', rsiVal != null ? rsiVal.toFixed(1) : '—');
  const rsiDisp = rsiZoneDisplay(rsiZone, rsiVal);
  const rsiZoneEl = $('rsi-zone-lbl');
  if (rsiZoneEl) { rsiZoneEl.textContent = rsiDisp.lbl; rsiZoneEl.style = rsiDisp.style; }

  // ── Trend alignment panel ──
  set('ema50-5m-mini',   `EMA50: ${fmtShort(e50_5)}`);
  set('ema200-5m-mini',  `EMA200: ${fmtShort(e200_5)}`);
  set('ema50-15m-mini',  `EMA50: ${fmtShort(e50_15)}`);
  set('ema200-15m-mini', `EMA200: ${fmtShort(e200_15)}`);

  const tb5  = $('trend-5m-badge');
  const tb15 = $('trend-15m-badge');
  if (tb5) {
    const map = { UP:['b-up','▲ UP'], DOWN:['b-down','▼ DOWN'], SIDE:['b-side','◆ SIDE'] };
    const [cls, lbl] = map[trend5m] || ['b-na','—'];
    tb5.className = 'tr-badge ' + cls; tb5.textContent = lbl;
  }
  if (tb15) {
    const map = { UP:['b-up','▲ UP'], DOWN:['b-down','▼ DOWN'], SIDE:['b-side','◆ SIDE'] };
    const [cls, lbl] = map[trend15m] || ['b-na','—'];
    tb15.className = 'tr-badge ' + cls; tb15.textContent = lbl;
  }

  // ── EMA value grid ──
  set('ema50-5m',   fmtPrice(e50_5));
  set('ema200-5m',  fmtPrice(e200_5));
  set('ema50-15m',  fmtPrice(e50_15));
  set('ema200-15m', fmtPrice(e200_15));

  // ── Detail table ──
  // 5M row
  const spread5  = (e50_5 != null && e200_5  != null) ? (e50_5  - e200_5).toFixed(1)  : '—';
  const spread15 = (e50_15 != null && e200_15 != null) ? (e50_15 - e200_15).toFixed(1) : '—';
  const spreadSign5  = parseFloat(spread5)  >= 0 ? '+' : '';
  const spreadSign15 = parseFloat(spread15) >= 0 ? '+' : '';

  const trendColor = t => t === 'UP' ? 'green' : t === 'DOWN' ? 'red' : 'yellow';
  const trendLabel = t => t === 'UP' ? '▲ UP' : t === 'DOWN' ? '▼ DOWN' : '◆ SIDE';

  set('dt-trend-5m',   cellBadge(trendColor(trend5m),  trendLabel(trend5m)));
  set('dt-spread-5m',  `<span style="color:${parseFloat(spread5)>=0?'var(--green)':'var(--red)'}">${spreadSign5}${spread5}</span>`);
  set('dt-rsi-5m',     rsiVal != null ? `${rsiVal.toFixed(1)}` : '—');
  set('dt-confirm-5m', trend5m !== 'SIDE'
    ? cellBadge(trendColor(trend5m), trend5m === signal.type.toUpperCase() ? '✓ YES' : '✗ NO')
    : cellBadge('dim', '— N/A'));

  set('dt-trend-15m',   cellBadge(trendColor(trend15m), trendLabel(trend15m)));
  set('dt-spread-15m',  `<span style="color:${parseFloat(spread15)>=0?'var(--green)':'var(--red)'}">${spreadSign15}${spread15}</span>`);
  set('dt-rsi-15m',     '—');   // RSI only calculated on 5m
  set('dt-confirm-15m', trend15m !== 'SIDE'
    ? cellBadge(trendColor(trend15m), trend15m === signal.type.toUpperCase() ? '✓ YES' : '✗ NO')
    : cellBadge('dim', '— N/A'));

  hideError();
  prevPrice = price;
}

/* ══════════════════════════════════════════════════════
   MAIN REFRESH CYCLE
══════════════════════════════════════════════════════ */
async function refresh() {
  try {
    // Fetch both timeframes in parallel
    const [closes5m, closes15m] = await Promise.all([
      fetchCloses('5'),
      fetchCloses('15'),
    ]);

    // Calculate all indicators
    const e50_5   = calcEMA(closes5m,  CFG.EMA_FAST);
    const e200_5  = calcEMA(closes5m,  CFG.EMA_SLOW);
    const e50_15  = calcEMA(closes15m, CFG.EMA_FAST);
    const e200_15 = calcEMA(closes15m, CFG.EMA_SLOW);
    const rsiVal  = calcRSI(closes5m,  CFG.RSI_PERIOD);

    // Trend directions
    const trend5m  = getTrend(e50_5,  e200_5);
    const trend15m = getTrend(e50_15, e200_15);
    const rsiZone  = getRsiZone(rsiVal);

    // Generate signal
    const signal = generateSignal(trend5m, trend15m, rsiZone);

    // Live price = last close from candles (most recent completed candle)
    let price    = closes5m[closes5m.length - 1];
    let change24h = null;

    // Enhance price with CoinGecko (more accurate spot + 24h change)
    // This is fire-and-forget — a failure doesn't block signal rendering
    try {
      const cg = await fetchCoinGeckoPrice();
      if (cg.price && cg.price > 0) {
        price     = cg.price;
        change24h = cg.change24h;
      }
    } catch (_) {
      // CoinGecko failed silently — candle close price is still shown
    }

    render({ price, change24h, e50_5, e200_5, e50_15, e200_15, rsiVal, trend5m, trend15m, signal });

    // ── Telegram alert hook (fire when signal changes) ──
    // Uncomment to enable:
    // if (signal.type !== 'wait') {
    //   sendTelegram(`${signal.emoji} ${signal.label} — BTC $${fmtPrice(price)}`);
    // }

  } catch (err) {
    showError(err.message || 'Market data unavailable. Retrying…');
    console.error('[Signal]', err);
  }

  startCountdown();
}

/* ══════════════════════════════════════════════════════
   COUNTDOWN TIMER
══════════════════════════════════════════════════════ */
function startCountdown() {
  cdSec = CFG.REFRESH_MS / 1000;
  clearInterval(cdTimer);
  tickCountdown();
  cdTimer = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  cdSec = Math.max(0, cdSec - 1);
  const numEl  = $('cd-num');
  const fillEl = $('cd-fill');
  if (numEl)  numEl.textContent  = cdSec + 's';
  if (fillEl) fillEl.style.width = (cdSec / (CFG.REFRESH_MS / 1000) * 100) + '%';
}

/* ══════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════ */
(function init() {
  refresh();                                      // immediate first load
  refreshTimer = setInterval(refresh, CFG.REFRESH_MS);  // then every 10s
})();

/* ══════════════════════════════════════════════════════
   FUTURE UPGRADE STUBS (ready to wire in)
══════════════════════════════════════════════════════

   ── GOLD (XAU/USD) ──
   To add Gold signals, duplicate the fetchCloses / render
   pipeline with a second CFG object:
     const GOLD = { SYMBOL:'XAUUSDT', SYMBOL_KC:'XAU-
