/*
 * SNIPER PRO — script.js
 *
 * All trading logic is embedded directly inside index.html
 * for maximum reliability on GitHub Pages.
 *
 * This file is intentionally empty.
 * You do NOT need to edit this file.
 *
 * ── HOW IT WORKS ──────────────────────────────────────
 * index.html connects to THREE Binance WebSocket streams:
 *   wss://stream.binance.com:9443/ws/btcusdt@kline_5m
 *   wss://stream.binance.com:9443/ws/btcusdt@kline_15m
 *   wss://stream.binance.com:9443/ws/btcusdt@ticker
 *
 * WebSockets have NO CORS restrictions — they work from
 * any browser on any network worldwide.
 *
 * On boot, it also tries to seed 210 historical candles
 * via REST (Binance direct → allorigins → corsproxy).
 * If REST seed fails, the WebSocket buffer fills in ~3 min.
 *
 * ── INDICATORS ────────────────────────────────────────
 * EMA50, EMA200, RSI14 — all calculated manually in JS.
 *
 * ── SIGNALS ───────────────────────────────────────────
 * STRONG BUY  → 5M UP  + 15M UP
 * STRONG SELL → 5M DOWN + 15M DOWN
 * WAIT        → mixed or sideways
 *
 * ── FUTURE UPGRADES ───────────────────────────────────
 * Gold (XAU/USD): change symbol to XAUUSDT in index.html
 * Telegram alerts: uncomment the TG stub in index.html
 * Support/Resistance: Math.min/max on closes buffer
 */
