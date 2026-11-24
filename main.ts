// Momentum paper-trading bot for the pump.fun replay harness.
//
// Strategy in one line: buy a new coin once strong early buying momentum
// shows up, then exit fast on a take-profit, a stop-loss, a trailing stop,
// or staleness. Small stakes, quick exits: on pump.fun most coins fade,
// so the bot banks the few fast runs and cuts the rest before they bleed.
//
// The bot talks to the harness through the kit SDK (vendor/makefun-bot.ts):
// the harness sends a `hello` first, then one `batch` of chain events per
// slot, and this bot answers each batch with its `orders`. A batch is only
// answered after the fills of the orders decided two slots earlier arrive
// (latency_slots = 2), so every decision here uses the state the harness
// has already settled, never a guess about an in-flight order.
//
// Price of a coin is its bonding-curve quote: virtual_quote_reserves /
// virtual_token_reserves. All decisions are pure functions of the hello
// seed and the replayed events, so two runs of this bot produce the same
// action log byte for byte: no clock, no randomness, no network.
//
// Guardrails this bot respects:
// - at most 5 open positions (hello.caps.max_open_positions)
// - at most 16 orders per batch, at most 1% of a mint's real SOL reserve
//   per batch's buys (hello.caps.max_order_bps_of_real_reserve)
// - every buy is at least 0.02 SOL, so each round trip counts toward the
//   20 distinct mints the competition requires
// - a drawdown guard: once paper equity falls 35% below starting capital,
//   the bot stops opening new positions and only manages exits, keeping
//   the run well inside the 50% maximum-drawdown guardrail.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tunable parameters (all fixed constants: deterministic) ---

// SOL spent on each fresh position (0.30 SOL): concentrated bets, not
// churn — this is a winner-takes-all sprint, so the bot swings for the
// few coins that actually run instead of grinding hundreds of small
// negative-expectancy round trips (curve fees alone are ~1.25% a side).
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 30n) / 100n;
// Do not open a position unless the size cap lets us spend at least this.
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n;
// Buy only after the price has risen this much above the first price seen.
const MOMENTUM_BPS = 500; // +5%
// ... and only after at least this many trades have printed on the curve.
const MIN_TRADES_BEFORE_BUY = 3;
// ... and only while the coin is this young (slots since its CreateEvent).
const MAX_BUY_AGE_SLOTS = 3600; // ~24 minutes of chain time
// ... and only with net buying pressure behind the move.
const MIN_BUY_PRESSURE = 1;
// Cap on fresh positions per run: after this many buys the bot only
// manages exits. Keeps the trade count low and the variance high.
const MAX_BUYS_PER_RUN = 30;
// Exit: take profit at +100% over the entry price; the trailing stop
// below is what normally banks a run.
const TAKE_PROFIT_BPS = 10000;
// Exit: stop loss at -30% under the entry price.
const STOP_LOSS_BPS = 3000;
// Exit: trailing stop, 20% below the best price seen since entry, armed
// once the position is up at least 50%.
const TRAIL_ARM_BPS = 5000;
const TRAIL_DROP_BPS = 2000;
// Exit: if a position is still open after this many slots and has not
// cleared +5%, close it to free the slot for a fresher coin.
const STALE_SLOTS = 4500; // ~30 minutes
const STALE_EXIT_BPS = 500; // +5%
// Drawdown guard: stop opening new positions below this equity fraction
// of starting capital.
const MAX_DRAWDOWN_BPS = 3500; // 35%
// Wide slippage so a fill is almost never refused for the price moving
// in the two slots of latency; the bonding curve, not slippage, is the
// real cost here.
const MAX_SLIPPAGE_BPS = 1000; // 10%

const BPS_DENOM = 10_000;

interface CoinMemory {
  /** Price (quote per token) at the first trade seen on this curve. */
  firstPrice: number;
  /** Slot of the CreateEvent, or of first sight. */
  createdSlot: number;
  /** Trades seen on this curve so far. */
  trades: number;
  /** Buys minus sells seen in TradeEvents (buying pressure). */
  buyPressure: number;
  /** Whether we already opened (and closed, or still hold) a position. */
  decided: boolean;
}

interface OpenPosition {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
}

const coins = new Map<string, CoinMemory>();
const entries = new Map<string, OpenPosition>();
let buysPlaced = 0;

/** Curve price: SOL per token, from virtual reserves. */
function curvePrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens === 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

/** Current mark price of a mint from the state's latest curve snapshot. */
function markPrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
}

/** Paper equity: cash plus positions valued at their mark prices. */
function paperEquity(state: BotState): bigint {
  let equity = state.cash;
  for (const [mint, holding] of state.positions) {
    const price = markPrice(state, mint);
    if (price <= 0) continue;
    // Value in lamports = tokens * price (SOL per token) * 1e9.
    equity += BigInt(Math.floor(Number(holding.token_amount) * price * 1e9));
  }
  return equity;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- fold this batch's events into per-coin memory ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            firstPrice: 0,
            createdSlot: e.slot,
            trades: 0,
            buyPressure: 0,
            decided: false,
          });
        }
        continue;
      }
      if (e.event === 'TradeEvent') {
        let mem = coins.get(e.mint);
        if (mem === undefined) {
          mem = { firstPrice: 0, createdSlot: e.slot, trades: 0, buyPressure: 0, decided: false };
          coins.set(e.mint, mem);
        }
        const price = curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (mem.trades === 0 && price > 0) mem.firstPrice = price;
        mem.trades += 1;
        mem.buyPressure += e.is_buy ? 1 : -1;
        continue;
      }
      // CompleteEvent: the curve migrated; never trade it again.
      const mem = coins.get(e.mint);
      if (mem !== undefined) mem.decided = true;
    }

    // --- exits first: manage every open position ---
    // Drop entry records for positions the harness already closed
    // (curve completion / flattening), so a failed sell never leaves a
    // position unmanaged. A buy still in flight (decided, filling two
    // slots later) is not a closed position: keep its record.
    for (const mint of [...entries.keys()]) {
      if (state.positions.has(mint)) continue;
      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          buyPending = true;
          break;
        }
      }
      if (!buyPending) entries.delete(mint);
    }
    for (const [mint, holding] of state.positions) {
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (entry === undefined || curve === undefined || curve.complete) continue;
      const price = markPrice(state, mint);
      if (price <= 0 || entry.entryPrice <= 0) continue;
      if (price > entry.peakPrice) entry.peakPrice = price;

      const gainBps = Math.floor(((price - entry.entryPrice) / entry.entryPrice) * BPS_DENOM);
      const trailDropBps = Math.floor(((entry.peakPrice - price) / entry.peakPrice) * BPS_DENOM);
      const ageSlots = state.slot - entry.entrySlot;

      let reason = '';
      if (gainBps >= TAKE_PROFIT_BPS) reason = 'take-profit';
      else if (gainBps <= -STOP_LOSS_BPS) reason = 'stop-loss';
      else if (gainBps >= TRAIL_ARM_BPS && trailDropBps >= TRAIL_DROP_BPS) reason = 'trailing-stop';
      else if (ageSlots >= STALE_SLOTS && gainBps < STALE_EXIT_BPS) reason = 'stale';
      if (reason === '') continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      if (free < tx) break;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
      free -= tx;
      // Keep the entry record until the position actually leaves
      // state.positions: if this sell is rejected or fails, the exit
      // logic above must still manage the position next batch.
    }

    // --- entries: momentum buys on fresh coins ---
    const startingCapital = BigInt(state.hello.capital.lamports);
    const equity = paperEquity(state);
    const drawdownBps = Number(((startingCapital - equity) * BigInt(BPS_DENOM)) / startingCapital);
    const mayBuy = drawdownBps < MAX_DRAWDOWN_BPS;

    if (mayBuy && buysPlaced < MAX_BUYS_PER_RUN) {
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        if (buysPlaced >= MAX_BUYS_PER_RUN) break;
        if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
        const mem = coins.get(e.mint);
        if (mem === undefined || mem.decided) continue;
        const curve = state.curves.get(e.mint);
        if (curve === undefined || curve.complete) continue;
        if (mem.trades < MIN_TRADES_BEFORE_BUY) continue;
        if (mem.firstPrice <= 0) continue;
        if (state.slot - mem.createdSlot > MAX_BUY_AGE_SLOTS) {
          mem.decided = true;
          continue;
        }
        const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const riseBps = Math.floor(((price - mem.firstPrice) / mem.firstPrice) * BPS_DENOM);
        // Momentum: price up 15% from first sight, with clear net buying
        // pressure behind the move.
        if (riseBps < MOMENTUM_BPS || mem.buyPressure < MIN_BUY_PRESSURE) continue;
        const cap = state.maxBuyLamports(e.mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        mem.decided = true;
        const buy: BuyInput = {
          side: 'buy',
          mint: e.mint,
          quote_lamports: amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(buy);
        free -= amount + tx;
        slots -= 1;
        buysPlaced += 1;
        entries.set(e.mint, { entryPrice: price, peakPrice: price, entrySlot: state.slot });
      }
    }

    return orders;
  },
});
