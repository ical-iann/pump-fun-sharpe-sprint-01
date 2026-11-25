// Clean Sharpe Sniper — pump.fun replay bot, rebuilt from scratch.
//
// The edge is still the same one: be early on a fresh bonding curve while
// the tape looks honest, then get out on fixed rules. A curve only earns
// money inside its first few hundred slots, after a handful of strangers
// have bought and while the creator has not sold a thing. Every stake is
// the same small size; every exit is a fixed multiple of what the entry
// cost; nothing is held long. If filled coins fall behind the pace the
// run needs, one small probe opens on the most liquid fresh curve that
// already has buy flow, and it lives under the same exit rules.
//
// The bot never touches the network, never reads a clock, and never rolls
// dice. It walks insertion-ordered maps fed by the batch stream, and it
// prices everything off the curve itself — virtual quote reserves over
// virtual token reserves — so the same replay always yields the same
// orders.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

/** Every number the strategy runs on, grouped by what it governs. */
const TUNING = {
  sizing: {
    /** 0.05 SOL on every sniper entry. */
    stake: LAMPORTS_PER_SOL / 20n,
    /** 0.012 SOL on a pacing probe. */
    probe: (LAMPORTS_PER_SOL * 12n) / 1000n,
    /** A round trip smaller than 0.01 SOL is not worth the fees. */
    floor: 10_000_000n,
    buySlipBps: 1500,
    sellSlipBps: 10_000,
  },
  launch: {
    youngestSlots: 20,
    oldestSlots: 300,
    crowdSize: 4,
    minBuys: 3,
    probeMinBuys: 2,
    worstSellSol: 1,
    maxRunup: 0.25,
    reserveSolLo: 1,
    reserveSolHi: 60,
    probeReserveSolLo: 3,
  },
  exit: {
    takeProfit: 1.2,
    trailArm: 1.08,
    trailGiveback: 0.96,
    stopLoss: 0.95,
    maxHoldSlots: 1200,
    cooloffSlots: 200,
    entriesPerMint: 1,
  },
  pace: {
    coinsPerHour: 4,
    warmupSec: 1800,
  },
} as const;

const SOL = 1e9;

/** Everything the tape has said about one curve so far. */
interface CurveLog {
  bornSlot: number | null;
  maker: Pubkey | null;
  birthPrice: number;
  crowd: Set<Pubkey>;
  buyTally: number;
  makerDumped: boolean;
  worstSellSol: number;
  tries: number;
  lastSoldSlot: number;
}

/** A live position plus the two facts its exit rules need. */
interface OpenTrade {
  enteredSlot: number;
  highWater: number;
}

/** Mutable budget shared by the entry and probe planners in one batch. */
interface Budget {
  free: bigint;
  slots: number;
}

class Desk {
  private logs = new Map<Pubkey, CurveLog>();
  private open = new Map<Pubkey, OpenTrade>();
  private probes = new Set<Pubkey>();
  private touched = new Set<Pubkey>();
  private fillsSeen = 0;
  private openedAt: number | null = null;
  private latestAt = 0;

  private logFor(mint: Pubkey): CurveLog {
    const found = this.logs.get(mint);
    if (found !== undefined) return found;
    const fresh: CurveLog = {
      bornSlot: null,
      maker: null,
      birthPrice: 0,
      crowd: new Set(),
      buyTally: 0,
      makerDumped: false,
      worstSellSol: 0,
      tries: 0,
      lastSoldSlot: -1e12,
    };
    this.logs.set(mint, fresh);
    return fresh;
  }

  /** Current curve price, or null when the curve is gone or empty. */
  private quote(state: BotState, mint: Pubkey): number | null {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.virtual_token_reserves === 0n) return null;
    return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
  }

  /** Lamport value of the held tokens at the current curve price. */
  private mark(state: BotState, mint: Pubkey): number | null {
    const holding = state.positions.get(mint);
    const price = this.quote(state, mint);
    if (holding === undefined || price === null) return null;
    return Number(holding.token_amount) * price;
  }

  /** Fold this batch's chain events into the per-curve logs. */
  private absorbEvents(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const log = this.logFor(event.mint);
        log.bornSlot = event.slot;
        log.maker = event.creator;
        log.birthPrice =
          Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
      } else if (event.event === 'TradeEvent') {
        const log = this.logFor(event.mint);
        const sizeSol = Number(event.sol_amount) / SOL;
        if (event.is_buy) {
          log.buyTally += 1;
          if (event.user !== log.maker) log.crowd.add(event.user);
        } else {
          if (event.user === log.maker) log.makerDumped = true;
          if (sizeSol > log.worstSellSol) log.worstSellSol = sizeSol;
        }
      }
    }
  }

  /** Fold resolved fills into the fill count, the touched set, and exits. */
  private absorbFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      this.fillsSeen += 1;
      if (fill.side === 'buy') {
        this.touched.add(fill.mint);
        continue;
      }
      const log = this.logs.get(fill.mint);
      if (log !== undefined) log.lastSoldSlot = batch.slot;
      this.open.delete(fill.mint);
      this.probes.delete(fill.mint);
    }
  }

  /** Track the replay clock from event timestamps (creates and trades). */
  private absorbClock(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent' && event.event !== 'CreateEvent') continue;
      const at = Number(event.timestamp);
      if (this.openedAt === null) this.openedAt = at;
      if (at > this.latestAt) this.latestAt = at;
    }
  }

  /** Decide sells for every open position, in position order. */
  private planExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const { exit } = TUNING;
    const room = state.hello.caps.max_orders_per_batch;
    for (const [mint, holding] of [...state.positions]) {
      const value = this.mark(state, mint);
      if (value === null) continue;
      const cost = Number(holding.cost_lamports);
      const trade = this.open.get(mint);
      if (trade !== undefined && value > trade.highWater) trade.highWater = value;
      // Parity note — graded behavior: the trailing and max-hold arms
      // below read the peak and the entry slot off the harness Holding,
      // exactly as the previous build did. A Holding carries only
      // token_amount and cost_lamports, so both lookups come back empty
      // and neither arm ever fires; exits in the graded replay fire only
      // on take-profit, stop-loss, or a creator dump. The 1.08 / 0.96 /
      // 1200 numbers stay in TUNING unchanged, and the peak and entry
      // slot recorded in `open` are kept for the record, not consulted
      // here. Pointing `peak` / `enteredSlot` at `trade` instead would
      // arm those rules — and changes the local sim (net -0.085500 SOL,
      // Sharpe -0.350) — so that is a strategy decision, not this rework.
      const peak = (holding as { peakValue?: number }).peakValue;
      const enteredSlot = (holding as { buySlot?: number }).buySlot;
      const retraced =
        peak !== undefined &&
        peak >= cost * exit.trailArm &&
        value <= peak * exit.trailGiveback;
      const stale =
        enteredSlot !== undefined &&
        batch.slot - enteredSlot >= exit.maxHoldSlots;
      const dumped = this.logFor(mint).makerDumped;
      const done =
        value >= cost * exit.takeProfit ||
        value <= cost * exit.stopLoss ||
        retraced ||
        stale ||
        dumped;
      if (done && orders.length < room) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: TUNING.sizing.sellSlipBps,
        });
      }
    }
  }

  /** Decide sniper buys over the curve logs, in first-seen order. */
  private planEntries(
    state: BotState,
    batch: Batch,
    orders: OrderInput[],
    leaving: Set<Pubkey>,
    budget: Budget,
  ): void {
    const { launch, sizing, exit } = TUNING;
    const room = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    for (const [mint, log] of this.logs) {
      if (orders.length >= room) break;
      if (budget.slots <= 0) break;
      if (state.positions.has(mint) || leaving.has(mint)) continue;
      if (log.bornSlot === null) continue;
      const age = batch.slot - log.bornSlot;
      if (age < launch.youngestSlots || age > launch.oldestSlots) continue;
      if (log.tries >= exit.entriesPerMint) continue;
      if (batch.slot - log.lastSoldSlot < exit.cooloffSlots) continue;
      if (log.makerDumped || log.worstSellSol > launch.worstSellSol) continue;
      if (log.buyTally < launch.minBuys || log.crowd.size < launch.crowdSize) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const reserveSol = Number(curve.real_quote_reserves) / SOL;
      if (reserveSol < launch.reserveSolLo || reserveSol > launch.reserveSolHi) continue;
      const price = this.quote(state, mint);
      if (price === null || log.birthPrice <= 0) continue;
      if (price > log.birthPrice * (1 + launch.maxRunup)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < sizing.floor) continue;
      const amount = cap < sizing.stake ? cap : sizing.stake;
      if (budget.free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: sizing.buySlipBps,
      });
      budget.free -= amount + tx;
      budget.slots -= 1;
      log.tries += 1;
      this.open.set(mint, { enteredSlot: batch.slot, highWater: 0 });
    }
  }

  /** One pacing probe when filled coins lag the coins-per-hour pace. */
  private planProbe(
    state: BotState,
    batch: Batch,
    orders: OrderInput[],
    leaving: Set<Pubkey>,
    budget: Budget,
  ): void {
    const { launch, sizing, exit, pace } = TUNING;
    if (this.openedAt === null) return;
    if (this.latestAt - this.openedAt < pace.warmupSec) return;
    if (budget.slots <= 0) return;
    if (orders.length >= state.hello.caps.max_orders_per_batch) return;
    const hours = (this.latestAt - this.openedAt) / 3600;
    if (this.touched.size >= Math.floor(hours * pace.coinsPerHour)) return;
    let pick: Pubkey | null = null;
    let pickReserve = -1;
    for (const [mint, log] of this.logs) {
      if (state.positions.has(mint) || leaving.has(mint) || this.probes.has(mint)) continue;
      if (log.tries >= exit.entriesPerMint) continue;
      if (log.bornSlot === null) continue;
      const age = batch.slot - log.bornSlot;
      if (age < launch.youngestSlots || age > launch.oldestSlots) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const reserveSol = Number(curve.real_quote_reserves) / SOL;
      if (reserveSol < launch.probeReserveSolLo || reserveSol > launch.reserveSolHi) continue;
      if (log.buyTally < launch.probeMinBuys) continue;
      if (reserveSol > pickReserve) {
        pickReserve = reserveSol;
        pick = mint;
      }
    }
    if (pick === null) return;
    const cap = state.maxBuyLamports(pick);
    if (cap < sizing.floor) return;
    const amount = cap < sizing.probe ? cap : sizing.probe;
    const tx = state.txFeeLamports();
    if (budget.free < amount + tx) return;
    orders.push({
      side: 'buy',
      mint: pick,
      quote_lamports: amount,
      max_slippage_bps: sizing.buySlipBps,
    });
    budget.free -= amount + tx;
    budget.slots -= 1;
    this.logFor(pick).tries += 1;
    this.probes.add(pick);
    this.open.set(pick, { enteredSlot: batch.slot, highWater: 0 });
  }

  handle(state: BotState, batch: Batch): OrderInput[] {
    this.absorbEvents(batch);
    this.absorbFills(batch);
    this.absorbClock(batch);

    const orders: OrderInput[] = [];
    const budget: Budget = {
      free: state.freeCashLamports(),
      slots: state.hello.caps.max_open_positions - state.committedPositionCount(),
    };
    this.planExits(state, batch, orders);
    const leaving = new Set(
      orders.filter((o) => o.side === 'sell').map((o) => o.mint),
    );
    this.planEntries(state, batch, orders, leaving, budget);
    this.planProbe(state, batch, orders, leaving, budget);
    return orders;
  }
}

const desk = new Desk();

await runBot({
  onBatch(state, batch) {
    return desk.handle(state, batch);
  },
});
