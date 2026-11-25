// Tiny SOL trend bot: per-symbol EMA 8/24 crossover on hourly closes.
// Deterministic, no clock/env/random. BigInt fixed-point EMA math only.
// BUY 20% of equity when fast EMA crosses above slow EMA and close > slow EMA.
// SELL the full position when fast crosses below slow, or close < slow * 0.98,
// or close < 0.92 * (highest close since entry).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const FAST_N = 8n;
const SLOW_N = 24n;
const MIN_CLOSES = 24;
const SCALE = 1_000_000n; // fixed-point scale for EMA values
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in micro-USDC
const MAX_SLIPPAGE_BPS = 100;

interface SymState {
  count: number;
  fast: bigint; // scaled by SCALE
  slow: bigint; // scaled by SCALE
  peak: bigint | null; // highest raw close since entry (null when flat)
}

const syms = new Map<string, SymState>();

function emaStep(prev: bigint, closeScaled: bigint, n: bigint): bigint {
  // EMA = prev + (2 / (n + 1)) * (close - prev), BigInt truncation, deterministic.
  return prev + ((2n * (closeScaled - prev)) / (n + 1n));
}

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const orders: OrderInput[] = [];
  for (const bar of _batch.bars) {
    const symbol = bar.symbol;
    const close = BigInt(bar.c);
    const closeScaled = close * SCALE;
    let s = syms.get(symbol);
    if (s === undefined) {
      s = { count: 0, fast: closeScaled, slow: closeScaled, peak: null };
      syms.set(symbol, s);
    }
    const prevFast = s.fast;
    const prevSlow = s.slow;
    s.count += 1;
    if (s.count > 1) {
      s.fast = emaStep(s.fast, closeScaled, FAST_N);
      s.slow = emaStep(s.slow, closeScaled, SLOW_N);
    }
    if (s.count < MIN_CLOSES) continue;

    const pos = state.positions.get(symbol);
    const heldQty = pos?.qty ?? 0n;

    if (heldQty > 0n) {
      // Track the peak close since entry (position is held this bar).
      if (s.peak === null || close > s.peak) s.peak = close;
      const crossDown = prevFast >= prevSlow && s.fast < s.slow;
      const belowSlow = closeScaled * 100n < s.slow * 98n;
      const trailingStop = s.peak !== null && close * 100n < s.peak * 92n;
      if (crossDown || belowSlow || trailingStop) {
        orders.push({ side: 'sell', symbol, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        s.peak = null;
      }
    } else {
      s.peak = null;
      const crossUp = prevFast <= prevSlow && s.fast > s.slow;
      const aboveSlow = closeScaled > s.slow;
      let exposure = 0n;
      for (const [heldSymbol, heldPos] of state.positions) {
        exposure += state.value(heldSymbol, heldPos.qty);
      }
      const exposureOk = exposure * 100n < state.equity * 90n;
      if (crossUp && aboveSlow && exposureOk) {
        let size = (state.equity * 2000n) / 10000n; // 20% of equity
        const room = state.weightRoom(symbol);
        if (size > room) size = room;
        if (size > state.cash) size = state.cash;
        if (size >= MIN_NOTIONAL) {
          orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
  }
  return orders;
}

await runBars({ onBatch });
