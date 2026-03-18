/**
 * SNIPER PRO — script.js  v5 (maximum compatibility)
 * ══════════════════════════════════════════════════
 * Tries 12+ different fetch strategies in sequence.
 * First success wins. Works on any network/region.
 * ══════════════════════════════════════════════════
 */
'use strict';

/* ─── CONFIG ─── */
const CFG = {
  EMA_FAST:    50,
  EMA_SLOW:    200,
  RSI_PERIOD:  14,
  LIMIT:       210,
  REFRESH_MS:  10000,
};

/* ─── STATE ─── */
let prevPrice = null, cdSec = 10, cdTimer = null, lastSrc = '—';

/* ══════════════════════════════════════════════════
   INDICATORS  (pure JS, no libraries)
══════════════════════════════════════════════════ */
function calcEMA(c, p) {
  if (!c || c.length < p) return null;
  const k = 2 / (p + 1);
  let v = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < c.length; i++) v = c[i] * k + v * (1 - k);
  return v;
}

function calcRSI(c, p) {
  if (!c || c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i]-c[i-1]; d>=0 ? g+=d : l-=d; }
  let ag = g/p, al = l/p;
  for (let i = p+1; i < c.length; i++) {
    const d = c[i]-c[i-1];
    ag = (ag*(p-1) + (d>0?d:0)) / p;
    al = (al*(p-1) + (d<0?-d:0)) / p;
  }
  return al===0 ? 100 : 100 - 100/(1 + ag/al);
}

function getTrend(f, s) {
  if (f==null||s==null) return 'SIDE';
  const r = (f-s)/s;
  return r > 0.0002 ? 'UP' : r < -0.0002 ? 'DOWN' : 'SIDE';
}

function getRsiZone(r) {
  if (r==null) return 'N';
  if (r>=52&&r<=68) return 'BUY';
  if (r>=32&&r<=48) return 'SELL';
  return 'N';
}

function makeSignal(t5, t15, rz) {
  if (t5==='UP'&&t15==='UP') return {
    type:'buy', label:'STRONG BUY', emoji:'🚀',
    desc: (rz==='BUY'||rz==='N')
      ? 'Both timeframes confirm UPTREND. RSI supports entry.'
      : 'Both timeframes confirm UPTREND. RSI elevated — manage risk.',
  };
  if (t5==='DOWN'&&t15==='DOWN') return {
    type:'sell', label:'STRONG SELL', emoji:'🔻',
    desc: (rz==='SELL'||rz==='N')
      ? 'Both timeframes confirm DOWNTREND. RSI supports entry.'
      : 'Both timeframes confirm DOWNTREND. RSI low — monitor closely.',
  };
  const desc = (t5!==t15&&t5!=='SIDE'&&t15!=='SIDE')
    ? `5M: ${t5} vs 15M: ${t15} — no confluence yet.`
    : 'Market ranging sideways. Waiting for breakout.';
  return { type:'wait', label:'WAIT', emoji:'⏳', desc };
}

/* ══════════════════════════════════════════════════
   FETCH ENGINE
   Tries every possible way to get candle data.
   Strategies grouped by source+method.
══════════════════════════════════════════════════ */

/** Safe JSON fetch with timeout */
async function jfetch(url, timeoutMs = 9000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const txt = await res.text();
  return JSON.parse(txt);
}

/** Extract a proper oldest-first closes array from raw kline data */
function extractCloses(raw, format) {
  /*
   * format 'binance':  [[ts,o,h,l,close,...], ...]  oldest-first, close=index4
   * format 'bybit':    {result:{list:[[ts,o,h,l,close,...]]}} newest-first, close=index4
   * format 'okx':      {data:[[ts,o,h,l,close,...]]} newest-first, close=index4
   * format 'kucoin':   {data:[[ts,open,close,high,low,vol,amt]]} newest-first, close=index2
   * format 'allorigins': wraps any of the above in {contents:"..."}
   */
  let data = raw;

  // Unwrap allorigins envelope
  if (data && typeof data.contents === 'string') {
    try { data = JSON.parse(data.contents); } catch(_) {}
  }

  // Bybit envelope
  if (data && data.result && Array.isArray(data.result.list)) {
    const arr = data.result.list;
    if (!arr.length) throw new Error('empty list');
    return arr.map(k => parseFloat(k[4])).reverse();
  }

  // OKX envelope
  if (data && data.code === '0' && Array.isArray(data.data)) {
    const arr = data.data;
    if (!arr.length) throw new Error('empty data');
    return arr.map(k => parseFloat(k[4])).reverse();
  }

  // KuCoin envelope
  if (data && data.code === '200000' && Array.isArray(data.data)) {
    const arr = data.data;
    if (!arr.length) throw new Error('empty data');
    return arr.map(k => parseFloat(k[2])).reverse();
  }

  // Binance / plain array format
  if (Array.isArray(data)) {
    if (!data.length) throw new Error('empty array');
    // Detect close index: Binance uses index 4
    const closeIdx = Array.isArray(data[0]) ? 4 : 0;
    if (Array.isArray(data[0])) {
      return data.map(k => parseFloat(k[closeIdx]));
    }
    // Flat array of numbers
    return data.map(k => parseFloat(k));
  }

  throw new Error('unrecognised format');
}

/** Validate a closes array */
function validateCloses(closes) {
  if (!Array.isArray(closes) || closes.length < CFG.EMA_SLOW + 5)
    throw new Error(`need ≥${CFG.EMA_SLOW+5} candles, got ${closes ? closes.length : 0}`);
  if (!closes.every(v => isFinite(v) && v > 0))
    throw new Error('non-finite values in closes');
  return closes;
}

/* All fetch strategies for a given interval.
   interval: '5' for 5-min, '15' for 15-min */
function buildStrategies(interval) {
  const lim = CFG.LIMIT;
  const iv  = interval; // '5' or '15'

  // Binance REST URLs
  const binUrl = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${iv}m&limit=${lim}`;
  const binUS  = `https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=${iv}m&limit=${lim}`;
  // Bybit
  const byUrl  = `https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${iv}&limit=${lim}`;
  // OKX
  const okxUrl = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${iv}m&limit=${lim}`;
  // KuCoin
  const kcNow  = Math.floor(Date.now()/1000);
  const kcFrom = kcNow - parseInt(iv)*60*(lim+10);
  const kcUrl  = `https://api.kucoin.com/api/v1/market/candles?type=${iv}min&symbol=BTC-USDT&startAt=${kcFrom}&endAt=${kcNow}`;

  // CORS proxy builders
  const ao  = u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`;
  const aoG = u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`;
  const cp  = u => `https://corsproxy.io/?${encodeURIComponent(u)}`;

  return [
    // ① Bybit direct
    { name:'Bybit',        url: byUrl,      parse: d=>extractCloses(d,'bybit')   },
    // ② OKX direct
    { name:'OKX',          url: okxUrl,     parse: d=>extractCloses(d,'okx')     },
    // ③ KuCoin direct
    { name:'KuCoin',       url: kcUrl,      parse: d=>extractCloses(d,'kucoin')  },
    // ④ Binance direct
    { name:'Binance',      url: binUrl,     parse: d=>extractCloses(d,'binance') },
    // ⑤ Binance US direct
    { name:'Binance US',   url: binUS,      parse: d=>extractCloses(d,'binance') },
    // ⑥ Bybit via allorigins raw
    { name:'Bybit/AO',     url: ao(byUrl),  parse: d=>extractCloses(d,'bybit')   },
    // ⑦ Binance via allorigins raw
    { name:'Bin/AO-raw',   url: ao(binUrl), parse: d=>extractCloses(d,'binance') },
    // ⑧ Binance via allorigins get (wraps in {contents:"..."})
    { name:'Bin/AO-get',   url: aoG(binUrl),parse: d=>extractCloses(d,'binance') },
    // ⑨ OKX via allorigins raw
    { name:'OKX/AO',       url: ao(okxUrl), parse: d=>extractCloses(d,'okx')     },
    // ⑩ Binance via corsproxy.io
    { name:'Bin/CP',       url: cp(binUrl), parse: d=>extractCloses(d,'binance') },
    // ⑪ Bybit via corsproxy.io
    { name:'Bybit/CP',     url: cp(byUrl),  parse: d=>extractCloses(d,'bybit')   },
    // ⑫ OKX via corsproxy.io
    { name:'OKX/CP',       url: cp(okxUrl), parse: d=>extractCloses(d,'okx')     },
  ];
}

/* Remember which strategy last worked per interval */
const lastGoodIdx = { '5': 0, '15': 0 };

async function fetchCloses(interval) {
  const strategies = buildStrategies(interval);
  const start = lastGoodIdx[interval] % strategies.length;
  const errors = [];

  for (let i = 0; i < strategies.length; i++) {
    const idx = (start + i) % strategies.length;
    const s   = strategies[idx];
    try {
      const raw    = await jfetch(s.url, 9000);
      const closes = validateCloses(s.parse(raw));
      lastGoodIdx[interval] = idx;
      lastSrc = s.name;
      console.log(`[Signal] ✓ ${s.name} (${interval}m) — ${closes.length} candles`);
      return closes;
    } catch(err) {
      console.warn(`[Signal] ✗ ${s.name} (${interval}m): ${err.message}`);
      errors.push(s.name + ': ' + err.message);
    }
  }
  throw new Error(`All ${strategies.length} sources failed for ${interval}m`);
}

/* ── CoinGecko price (24h change overlay) ── */
async function fetchCGPrice() {
  const d = await jfetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true`,
    7000
  );
  const b = d.bitcoin;
  if (!b || !b.usd) throw new Error('CG: no data');
  return { price: b.usd, change24h: b.usd_24h_change };
}

/* ══════════════════════════════════════════════════
   UI
══════════════════════════════════════════════════ */
const $   = id => document.getElementById(id);
const set = (id, html) => { const e=$(id); if(e) e.innerHTML=html; };
const fmt = n => (n==null||isNaN(n)) ? '—'
  : n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtS = n => (n==null||isNaN(n)) ? '—'
  : Math.round(n).toLocaleString('en-US');

function showErr(msg) {
  const e=$('error-box'); if(e){e.style.display='block';e.textContent='⚠ '+msg;}
}
function hideErr() { const e=$('error-box'); if(e) e.style.display='none'; }

function trendBadgeHTML(t) {
  const m={UP:['b-up','▲ UP'],DOWN:['b-down','▼ DOWN'],SIDE:['b-side','◆ SIDE']};
  const[c,l]=m[t]||['b-na','—'];
  return `<span class="tr-badge ${c}">${l}</span>`;
}

function cellSpan(color, text) {
  const cols={green:'var(--green)',red:'var(--red)',yellow:'var(--yellow)',dim:'var(--text3)'};
  return `<span style="color:${cols[color]||cols.dim};font-weight:700">${text}</span>`;
}

function render(data) {
  const { price, change24h, e50_5, e200_5, e50_15, e200_15, rsiVal, t5, t15, sig } = data;

  /* price */
  const pe=$('btc-price');
  if(pe){
    pe.classList.remove('shim');
    pe.textContent='$'+fmt(price);
    if(prevPrice!==null){
      pe.classList.toggle('up',   price>prevPrice);
      pe.classList.toggle('down', price<prevPrice);
      setTimeout(()=>pe.classList.remove('up','down'), 700);
    }
  }
  if(change24h!=null&&isFinite(change24h)){
    const s=change24h>=0?'+':'', cl=change24h>=0?'up':'down';
    set('btc-change',`<span class="${cl}">${s}${change24h.toFixed(2)}% 24h</span>`);
  }
  set('last-updated','UPDATED '+new Date().toLocaleTimeString('en-US',{hour12:false}));
  set('src-tag','SRC: '+lastSrc);

  /* signal card */
  const card=$('signal-card');
  if(card) card.className='sig-card '+sig.type;
  const ste=$('signal-text');
  if(ste){ste.classList.remove('shim');ste.textContent=sig.emoji+' '+sig.label;}
  set('signal-desc',sig.desc);

  /* RSI */
  const rz=getRsiZone(rsiVal);
  const rv=rsiVal!=null?Math.min(100,Math.max(0,rsiVal)):50;
  set('rsi-number',rsiVal!=null?rsiVal.toFixed(1):'—');
  const rzlbl={BUY:'BUY ZONE',SELL:'SELL ZONE',N:rsiVal!=null?(rsiVal>70?'OVERBOUGHT':rsiVal<30?'OVERSOLD':'NEUTRAL'):'—'};
  const rzcol={BUY:'var(--green)',SELL:'var(--red)',N:'var(--text2)'};
  const rzEl=$('rsi-zone-lbl');
  if(rzEl){rzEl.textContent=rzlbl[rz];rzEl.style.color=rzcol[rz];}
  const rf=$('rsi-fill'), rt=$('rsi-thumb');
  if(rf) rf.style.width=rv+'%';
  if(rt) rt.style.left =rv+'%';

  /* trend panel */
  set('ema50-5m-mini',  `EMA50: ${fmtS(e50_5)}`);
  set('ema200-5m-mini', `EMA200: ${fmtS(e200_5)}`);
  set('ema50-15m-mini', `EMA50: ${fmtS(e50_15)}`);
  set('ema200-15m-mini',`EMA200: ${fmtS(e200_15)}`);

  const tb5=$('trend-5m-badge'), tb15=$('trend-15m-badge');
  const bmap={UP:['b-up','▲ UP'],DOWN:['b-down','▼ DOWN'],SIDE:['b-side','◆ SIDE']};
  if(tb5){  const[c,l]=bmap[t5]||['b-na','—'];  tb5.className='tr-badge '+c; tb5.textContent=l; }
  if(tb15){ const[c,l]=bmap[t15]||['b-na','—']; tb15.className='tr-badge '+c;tb15.textContent=l; }

  /* EMA grid */
  set('ema50-5m',   fmt(e50_5));
  set('ema200-5m',  fmt(e200_5));
  set('ema50-15m',  fmt(e50_15));
  set('ema200-15m', fmt(e200_15));

  /* detail table */
  const spread5  = (e50_5!=null&&e200_5!=null)  ? (e50_5-e200_5).toFixed(1)   : null;
  const spread15 = (e50_15!=null&&e200_15!=null) ? (e50_15-e200_15).toFixed(1) : null;
  const tcol=t=>t==='UP'?'green':t==='DOWN'?'red':'yellow';
  const tlbl=t=>t==='UP'?'▲ UP':t==='DOWN'?'▼ DOWN':'◆ SIDE';

  set('dt-trend-5m',   cellSpan(tcol(t5), tlbl(t5)));
  set('dt-spread-5m',  spread5!=null ? `<span style="color:${parseFloat(spread5)>=0?'var(--green)':'var(--red)'}">${parseFloat(spread5)>=0?'+':''}${spread5}</span>` : '—');
  set('dt-rsi-5m',     rsiVal!=null  ? rsiVal.toFixed(1) : '—');
  set('dt-confirm-5m', t5!=='SIDE'   ? cellSpan(tcol(t5), sig.type!=='wait'&&t5==='UP'&&sig.type==='buy'||t5==='DOWN'&&sig.type==='sell'?'✓ YES':'— —') : cellSpan('dim','N/A'));

  set('dt-trend-15m',   cellSpan(tcol(t15), tlbl(t15)));
  set('dt-spread-15m',  spread15!=null ? `<span style="color:${parseFloat(spread15)>=0?'var(--green)':'var(--red)'}">${parseFloat(spread15)>=0?'+':''}${spread15}</span>` : '—');
  set('dt-rsi-15m',     '—');
  set('dt-confirm-15m', t15!=='SIDE'  ? cellSpan(tcol(t15), sig.type!=='wait'&&t15==='UP'&&sig.type==='buy'||t15==='DOWN'&&sig.type==='sell'?'✓ YES':'— —') : cellSpan('dim','N/A'));

  hideErr();
  prevPrice=price;
}

/* ══════════════════════════════════════════════════
   MAIN REFRESH
══════════════════════════════════════════════════ */
async function refresh() {
  try {
    const [c5, c15] = await Promise.all([fetchCloses('5'), fetchCloses('15')]);

    const e50_5   = calcEMA(c5,  CFG.EMA_FAST);
    const e200_5  = calcEMA(c5,  CFG.EMA_SLOW);
    const e50_15  = calcEMA(c15, CFG.EMA_FAST);
    const e200_15 = calcEMA(c15, CFG.EMA_SLOW);
    const rsiVal  = calcRSI(c5,  CFG.RSI_PERIOD);
    const t5      = getTrend(e50_5,  e200_5);
    const t15     = getTrend(e50_15, e200_15);
    const rz      = getRsiZone(rsiVal);
    const sig     = makeSignal(t5, t15, rz);

    /* best available price */
    let price = c5[c5.length-1], change24h = null;
    try { const cg=await fetchCGPrice(); price=cg.price; change24h=cg.change24h; } catch(_){}

    render({ price, change24h, e50_5, e200_5, e50_15, e200_15, rsiVal, t5, t15, sig });
  } catch(err) {
    showErr(err.message||'All data sources failed. Retrying…');
    console.error('[Signal]', err);
  }
  startCD();
}

/* ══════════════════════════════════════════════════
   COUNTDOWN
══════════════════════════════════════════════════ */
function startCD() {
  cdSec=CFG.REFRESH_MS/1000; clearInterval(cdTimer); tickCD();
  cdTimer=setInterval(tickCD,1000);
}
function tickCD() {
  cdSec=Math.max(0,cdSec-1);
  const n=$('cd-num'),f=$('cd-fill');
  if(n) n.textContent=cdSec+'s';
  if(f) f.style.width=(cdSec/(CFG.REFRESH_MS/1000)*100)+'%';
}

/* ══════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════ */
refresh();
setInterval(refresh, CFG.REFRESH_MS);

/* ══════════════════════════════════════════════════
   FUTURE STUBS
   ── Gold: change buildStrategies() to use XAUUSDT
   ── Telegram: fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage?...`)
   ── Support/Resistance: Math.min/max over closes.slice(-lookback)
══════════════════════════════════════════════════ */
