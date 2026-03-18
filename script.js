// Free CORS proxy
const proxyURL = "https://api.allorigins.win/raw?url=";

// Helper: EMA calculation
function calculateEMA(closes, period) {
    let k = 2 / (period + 1);
    let emaArray = [];
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
    emaArray[period - 1] = ema;
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
        emaArray[i] = ema;
    }
    return emaArray;
}

// Get trend based on EMA50 & EMA200
function getTrend(closes) {
    let ema50 = calculateEMA(closes, 50);
    let ema200 = calculateEMA(closes, 200);
    let last50 = ema50[ema50.length - 1];
    let last200 = ema200[ema200.length - 1];
    return last50 > last200 ? "UP" : last50 < last200 ? "DOWN" : "SIDE";
}

// Fetch Binance candles using proxy
async function getCandles(interval) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=200`;
    const res = await fetch(proxyURL + encodeURIComponent(url));
    const data = await res.json();
    return data.map(c => parseFloat(c[4])); // closing prices
}

// Main update function
async function update() {
    try {
        const closes5 = await getCandles("5m");
        const closes15 = await getCandles("15m");

        const trend5 = getTrend(closes5);
        const trend15 = getTrend(closes15);

        let signalText = "WAIT ⏳";
        let signalClass = "wait";

        if (trend5 === "UP" && trend15 === "UP") {
            signalText = "STRONG BUY 🚀";
            signalClass = "buy";
        } else if (trend5 === "DOWN" && trend15 === "DOWN") {
            signalText = "STRONG SELL 🔻";
            signalClass = "sell";
        }

        // Update DOM
        document.getElementById("price").innerText = "BTC Price: $" + closes5[closes5.length - 1];
        const el = document.getElementById("signal");
        el.innerText = signalText;
        el.className = "signal " + signalClass;

    } catch (e) {
        console.error("Error fetching data:", e);
        document.getElementById("signal").innerText = "ERROR ⚠️";
    }
}

// Auto update every 10 seconds
setInterval(update, 10000);
update();
