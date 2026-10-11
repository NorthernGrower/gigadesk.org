import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchCandles, round } from "../../shared/market.ts";
import { analyzeCoin } from "../../shared/strategy.ts";
import { ema, rsi, macd, bollinger } from "../../shared/indicators.ts";

const CACHE = new Map();
const AI_TTL = 10 * 60 * 1000;
const num = (v) => (v == null || Number.isNaN(v) ? null : round(v, 6));

const AI_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["strong_long", "long", "watch", "short", "strong_short", "avoid"],
    },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    thesis: { type: "string" },
    setup_quality: { type: "string" },
    risks: { type: "string" },
    entry: { type: "number" },
    target: { type: "number" },
    stop: { type: "number" },
    invalidation: { type: "string" },
    horizon: { type: "string" },
  },
  required: ["verdict", "confidence", "thesis", "risks", "entry", "target", "stop"],
};

function buildPrompt(coin, timeframe, snapshot) {
  const i = snapshot.indicators;
  return `You are a professional crypto technical analyst. Write a specific, honest read on one setup for a trader.

Coin: ${coin.name} (${snapshot.symbol})
Timeframe: ${timeframe}
Price: ${snapshot.price} USD | 24h ${snapshot.change24h}% | 7d ${snapshot.change7d}% | cap tier ${snapshot.market_cap_bucket}
Indicators: RSI(14) ${i.rsi} | MACD histogram ${i.macd_hist} | EMA20 ${i.ema20} | EMA50 ${i.ema50} | EMA200 ${i.ema200 ?? "n/a"} | Bollinger ${i.bb_lower} to ${i.bb_upper} | ATR ${i.atr_pct}% of price | volume vs 20-bar average ${i.vol_ratio}x
Trend tools: ADX(14) ${i.adx} with +DI ${i.plus_di} / -DI ${i.minus_di} | trend ${i.trend} | stochastic %K ${i.stoch_k} (%D ${i.stoch_d}) | higher timeframe (4x) ${i.htf_trend} | swing structure ${i.structure}
Flow tools: on-balance volume 10-bar change ${i.obv_change_pct}% | RSI divergence ${i.rsi_divergence ?? "none"} | VWAP ${i.vwap ?? "n/a"} (price ${i.vwap_dist_pct ?? "n/a"}% from it) | Bollinger width percentile ${i.bb_width_percentile}%
Structure: swing high ${i.swing_high} | swing low ${i.swing_low} | nearest support ${i.support ?? "n/a"} | nearest resistance ${i.resistance ?? "n/a"} | room to the level ahead ${snapshot.room_pct}%
Last candle: ${snapshot.pattern} (${snapshot.pattern_bias})
Screener levels: side ${snapshot.side}, entry ${snapshot.entry}, target ${snapshot.target}, stop ${snapshot.stop}, move required ${snapshot.required_move_pct}%, risk/reward ${snapshot.risk_reward}, stop distance ${snapshot.stop_pct}%
Mechanical score ${snapshot.score}/100 — quality ${snapshot.quality}, ${snapshot.confluence} independent confirmations. Desk scores: trend ${snapshot.categories?.trend}, momentum ${snapshot.categories?.momentum}, volume ${snapshot.categories?.volume}, location ${snapshot.categories?.location}, risk ${snapshot.categories?.volatility}. Reasons: ${(snapshot.reasons || []).join("; ")}

Rules: judge whether the setup is worth taking and in which direction, refine the entry, target and stop if the numbers above are off, state what would invalidate it, and be explicit about the main risks. Never promise a return and never invent data beyond what is given. Keep thesis under 90 words and risks under 60 words.`;
}

async function aiAnalysis(base44, coin, timeframe, snapshot) {
  const key = `${snapshot.symbol}:${timeframe}:${Math.round(snapshot.score / 5)}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < AI_TTL) return hit.value;

  const value = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt: buildPrompt(coin, timeframe, snapshot),
    response_json_schema: AI_SCHEMA,
  });
  CACHE.set(key, { value, at: Date.now() });
  return value;
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const symbol = String(body.symbol || "").toUpperCase();
    if (!symbol) return Response.json({ error: "A coin symbol is required" }, { status: 400 });
    const timeframe = ["15m", "1h", "4h", "12h", "1d", "1w", "1M"].includes(body.timeframe)
      ? body.timeframe
      : "1h";
    const withAi = body.withAi === true;

    const { coins } = await fetchMarkets();
    const coin = coins.find((c) => c.symbol === symbol);
    if (!coin) {
      return Response.json({ error: `${symbol} is not in the tracked market` }, { status: 404 });
    }

    const candles = await fetchCandles(symbol, timeframe, 300);
    if (!candles || candles.length < 80) {
      return Response.json(
        { error: `Not enough chart history for ${symbol} on this timeframe` },
        { status: 404 },
      );
    }

    const moves = coins.map((c) => c.change24h).filter(Number.isFinite).sort((a, b) => a - b);
    const medianChange24h = moves.length ? moves[Math.floor(moves.length / 2)] : 0;
    const snapshot = analyzeCoin(coin, candles, { medianChange24h, dailyTargetPct: 2 });
    if (!snapshot) {
      return Response.json({ error: "Not enough data to analyse this coin" }, { status: 422 });
    }

    const closes = candles.map((c) => c.c);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    const rsiSeries = rsi(closes, 14);
    const macdRes = macd(closes);
    const bb = bollinger(closes, 20, 2);

    const start = Math.max(0, candles.length - 200);
    const chart = [];
    for (let i = start; i < candles.length; i++) {
      chart.push({
        t: candles[i].t,
        o: candles[i].o,
        h: candles[i].h,
        l: candles[i].l,
        c: candles[i].c,
        v: candles[i].v,
        ema20: num(e20[i]),
        ema50: num(e50[i]),
        ema200: num(e200[i]),
        bbUpper: num(bb.upper[i]),
        bbLower: num(bb.lower[i]),
        rsi: num(rsiSeries[i]),
        macd: num(macdRes.macd[i]),
        macdSignal: num(macdRes.signal[i]),
        macdHist: num(macdRes.hist[i]),
      });
    }

    let analysis = null;
    if (withAi) {
      analysis = await aiAnalysis(base44, coin, timeframe, snapshot).catch(() => null);
    }

    return Response.json({
      coin: {
        symbol: snapshot.symbol,
        name: snapshot.name,
        image: snapshot.image,
        coingecko_id: snapshot.coingecko_id,
        price: snapshot.price,
        change24h: snapshot.change24h,
        change7d: snapshot.change7d,
        market_cap: snapshot.market_cap,
        market_cap_bucket: snapshot.market_cap_bucket,
        volume24h: snapshot.volume24h,
      },
      timeframe,
      candles: chart,
      snapshot,
      analysis,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}