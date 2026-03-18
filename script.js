async function getCandles(interval) {
    let res = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=100`);
    let data = await res.json();
    return data.map(c => parseFloat(c[4]));
}

// Indicators
function calculateIndicators(closes) {

    const ema50 = window.technicalindicators.EMA.calculate({
        period: 50,
        values: closes
    });

    const ema200 = window.technicalindicators.EMA.calculate({
        period: 200,
        values: closes
    });

    const rsi = window.technicalindicators.RSI.calculate({
        values: closes,
        period: 14
    });

    const macd = window.technicalindicators.MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9
    });

    return {
        ema50: ema50[ema50.length - 1],
        ema200: ema200[ema200.length - 1],
        rsi: rsi[rsi.length - 1],
        macd: macd[macd.length - 1]
    };
}

// Trend
function getTrend(ema50, ema200) {
    if (ema50 > ema200) return "UP";
    if (ema50 < ema200) return "DOWN";
    return "SIDE";
}

// Signal Logic (Improved)
function getSignal(tf15, tf5, rsi5, macd5) {

    // STRONG BUY
    if (
        tf15 === "UP" &&
        tf5 === "UP" &&
        rsi5 > 52 && rsi5 < 65 &&
        macd5.MACD > macd5.signal
    ) {
        return {text: "STRONG BUY 🚀", class: "buy"};
    }

    // STRONG SELL
    if (
        tf15 === "DOWN" &&
        tf5 === "DOWN" &&
        rsi5 < 48 && rsi5 > 35 &&
        macd5.MACD < macd5.signal
    ) {
        return {text: "STRONG SELL 🔻", class: "sell"};
    }

    return {text: "WAIT ⏳", class: "wait"};
}

// MAIN
async function update() {

    try {

        let closes5 = await getCandles("5m");
        let closes15 = await getCandles("15m");

        let ind5 = calculateIndicators(closes5);
        let ind15 = calculateIndicators(closes15);

        let tf5 = getTrend(ind5.ema50, ind5.ema200);
        let tf15 = getTrend(ind15.ema50, ind15.ema200);

        let signal = getSignal(tf15, tf5, ind5.rsi, ind5.macd);

        document.getElementById("price").innerText =
            "BTC Price: $" + closes5[closes5.length - 1];

        let el = document.getElementById("signal");
        el.innerText = signal.text;
        el.className = "signal " + signal.class;

    } catch (e) {
        document.getElementById("signal").innerText = "ERROR ⚠️";
    }
}

setInterval(update, 10000);
update();
