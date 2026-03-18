// Helper: EMA calculation
function calculateEMA(closes, period) {
    let k = 2 / (period + 1);
    let emaArray = [];
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period; // first EMA = SMA
    emaArray[period - 1] = ema;

    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
        emaArray[i] = ema;
    }

    return emaArray;
}

// Helper: RSI calculation
function calculateRSI(closes, period = 14) {
    let gains = 0;
    let losses = 0;
    let rsiArray = [];

    for (let i = 1; i <= period; i++) {
        let change = closes[i] - closes[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArray[period] = 100 - 100 / (1 + rs);

    for (let i = period + 1; i < closes.length; i++) {
        let change = closes[i] - closes[i - 1];
        let gain = change > 0 ? change : 0;
        let loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiArray[i] = 100 - 100 / (1 + rs);
    }

    return rsiArray;
}

// Fetch Binance candlesticks
async function getCandles(interval) {
    let res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=200`);
    let data = await res.json();
    return data.map(c => parseFloat(c[4])); // close prices
}

// Determine trend based on EMA
function getTrend(closes, period1 = 50, period2 = 200) {
    let ema50 = calculateEMA(closes, period1);
    let ema200 = calculateEMA(closes, period2);

    let lastEma50 = ema50[ema50.length - 1];
    let lastEma200 = ema200[ema200.length - 1];

    return {
        trend: lastEma50 > lastEma200 ? "UP" : lastEma50 < lastEma200 ? "DOWN" : "SIDE",
        ema50: lastEma50,
        ema200: lastEma200
    };
}

// Main update function
async function update() {
    try {
        let closes5 = await getCandles("5m");
        let closes15 = await getCandles("15m");

        // Get trends
        let trend5 = getTrend(closes5);
        let trend15 = getTrend(closes15);

        // RSI for info (optional)
        let rsi5 = calculateRSI(closes5);
        let lastRsi5 = rsi5[rsi5.length - 1];

        // Signal Logic
        let signalText = "WAIT ⏳";
        let signalClass = "wait";

        if (trend5.trend === "UP" && trend15.trend === "UP") {
            signalText = "STRONG BUY 🚀";
            signalClass = "buy";
        } else if (trend5.trend === "DOWN" && trend15.trend === "DOWN") {
            signalText = "STRONG SELL 🔻";
            signalClass = "sell";
        }

        // Update DOM
        document.getElementById("price").innerText = "BTC Price: $" + closes5[closes5.length - 1];
        let el = document.getElementById("signal");
        el.innerText = signalText;
        el.className = "signal " + signalClass;

    } catch (e) {
        document.getElementById("signal").innerText = "ERROR ⚠️";
        console.error(e);
    }
}

// Update every 10 seconds
setInterval(update, 10000);
update();
