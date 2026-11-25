// Launch sniper for the pump.fun replay (hourly Sharpe, not PnL).
//
// Idea: the edge on a bonding curve is being early. We watch every curve
// from its CreateEvent and buy only in its first 300 slots, when the tape
// shows a healthy launch: at least 4 distinct non-creator buyers, the
// creator has not sold anything, no single sell larger than 1 SOL, price
// run-up from the create price at most +25%, and real SOL between 1 and 60.
// One small fixed size (0.05 SOL), take profit +20%, stop -5%, a trailing
// stop once up 8%, never hold past ~4 minutes, exit at once if the creator
// sells after we buy.
//
// Guardrail pacing: the run must end with round trips of >= 0.01 SOL on at
// least 20 distinct mints. If filled coins lag the pace (fewer than 4 new
// coins per elapsed hour after the first 30 minutes), one small "scout"
// (0.012 SOL) is opened on the most liquid fresh curve with recent buys and
// exited on the same tight rules. Scouts are real trades on curves with
// genuine buy flow, not wash flips.
//
// Deterministic: no clock, no randomness, no network. Iteration only over
// insertion-ordered maps fed by the batch stream. Price is the bonding-curve
// ratio virtual_quote_reserves / virtual_token_reserves.

import { LAMPORTS_PER_SOL, runBot, type BotState, type BuyInput, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const STAKE = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per position
const SCOUT_STAKE = (LAMPORTS_PER_SOL * 12n) / 1000n; // 0.012 SOL
const MIN_BUY = 10_000_000n; // 0.01 SOL round-trip floor
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10_000;
const MIN_AGE_SLOTS = 20;
const MAX_AGE_SLOTS = 300;
const MIN_BUYERS = 4;
const MIN_BUYS = 3;
const MAX_SINGLE_SELL_SOL = 1;
const MAX_RUNUP = 0.25; // price now <= create price * 1.25
const MIN_RQ_SOL = 1;
const MAX_RQ_SOL = 60;
const TP = 1.2;
const TRAIL_ARM = 1.08;
const TRAIL = 0.96; // once up 8%, sell if value falls to 96% of peak
const SL = 0.95;
const MAX_HOLD_SLOTS = 1200;
const COOLDOWN_SLOTS = 200;
const MAX_ENTRIES_PER_MINT = 1;
const PACE_COINS_PER_HOUR = 4;
const PACE_WARMUP_SECS = 1800;

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  buyers: Set<string>;
  buys: number;
  creatorSold: boolean;
  maxSellSol: number;
  entries: number;
  lastExit: number;
}

interface Held {
  buySlot: number;
  peakValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const scouts = new Set<Pubkey>();
const myCoins = new Set<Pubkey>();
let myFills = 0;
let firstTime: number | null = null;
let lastTime = 0;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, creator: null, createPrice: 0, buyers: new Set(), buys: 0, creatorSold: false, maxSellSol: 0, entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

function priceOf(state: BotState, mint: Pubkey): number | null {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function valueOf(state: BotState, mint: Pubkey): number | null {
  const pos = state.positions.get(mint);
  const p = priceOf(state, mint);
  if (pos === undefined || p === null) return null;
  return Number(pos.token_amount) * p;
}

await runBot({
  onBatch(state, batch) {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.creator = e.creator;
        t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / 1e9;
        if (e.is_buy) {
          t.buys++;
          if (e.user !== t.creator) t.buyers.add(e.user);
        } else {
          if (e.user === t.creator) t.creatorSold = true;
          if (sol > t.maxSellSol) t.maxSellSol = sol;
        }
      }
    }
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        if (f.side === 'buy') myCoins.add(f.mint);
      }
      if (f.status === 'filled' && f.side === 'sell' && !f.client_id.startsWith('_')) {
        const t = tapes.get(f.mint);
        if (t !== undefined) t.lastExit = batch.slot;
        held.delete(f.mint);
        scouts.delete(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.event === 'TradeEvent' || e.event === 'CreateEvent') {
        const ts = Number(e.timestamp);
        if (firstTime === null) firstTime = ts;
        if (ts > lastTime) lastTime = ts;
      }
    }

    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- exits ---
    for (const [mint, h] of [...state.positions]) {
      const pos = state.positions.get(mint)!;
      const value = valueOf(state, mint);
      if (value === null) continue;
      const cost = Number(pos.cost_lamports);
      const creatorDumped = tapeOf(mint).creatorSold;
      if (value > h.peakValue) h.peakValue = value;
      const trailed = h.peakValue >= cost * TRAIL_ARM && value <= h.peakValue * TRAIL;
      if (value >= cost * TP || value <= cost * SL || trailed || batch.slot - h.buySlot >= MAX_HOLD_SLOTS || creatorDumped) {
        if (orders.length < caps.max_orders_per_batch) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        }
      }
    }

    // --- sniper entries ---
    const selling = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
    for (const [mint, t] of tapes) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (state.positions.has(mint) || selling.has(mint)) continue;
      if (t.created === null) continue;
      const age = batch.slot - t.created;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (t.entries >= MAX_ENTRIES_PER_MINT) continue;
      if (batch.slot - t.lastExit < COOLDOWN_SLOTS) continue;
      if (t.creatorSold || t.maxSellSol > MAX_SINGLE_SELL_SOL) continue;
      if (t.buys < MIN_BUYS || t.buyers.size < MIN_BUYERS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const rqSol = Number(curve.real_quote_reserves) / 1e9;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      const price = priceOf(state, mint);
      if (price === null || t.createPrice <= 0) continue;
      if (price > t.createPrice * (1 + MAX_RUNUP)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      slots--;
      t.entries++;
      held.set(mint, { buySlot: batch.slot, peakValue: 0 });
    }

    // --- pacing scout ---
    if (firstTime !== null && lastTime - firstTime >= PACE_WARMUP_SECS && slots > 0 && orders.length < caps.max_orders_per_batch) {
      const elapsedHours = (lastTime - firstTime) / 3600;
      const need = Math.floor(elapsedHours * PACE_COINS_PER_HOUR);
      if (myCoins.size < need) {
        let best: Pubkey | null = null;
        let bestRq = -1;
        for (const [mint, t] of tapes) {
          if (state.positions.has(mint) || selling.has(mint) || scouts.has(mint)) continue;
          if (t.entries >= MAX_ENTRIES_PER_MINT) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / 1e9;
          if (rqSol < 3 || rqSol > MAX_RQ_SOL) continue;
          if (t.buys < 2) continue;
          if (rqSol > bestRq) {
            bestRq = rqSol;
            best = mint;
          }
        }
        if (best !== null) {
          const cap = state.maxBuyLamports(best);
          if (cap >= MIN_BUY) {
            const amount = cap < SCOUT_STAKE ? cap : SCOUT_STAKE;
            if (free >= amount + tx) {
              orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
              free -= amount + tx;
              slots--;
              tapeOf(best).entries++;
              scouts.add(best);
              held.set(best, { buySlot: batch.slot, peakValue: 0 });
            }
          }
        }
      }
    }

    return orders;
  },
});
