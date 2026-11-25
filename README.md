[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ical-iann/pump-fun-sharpe-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ical-iann/pump-fun-sharpe-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean Sharpe Sniper — pump.fun replay bot

A small, steady paper-trading bot for the pump.fun replay: it snipes healthy launches early (first 300 slots, ≥4 distinct non-creator buyers, creator never sold, run-up ≤25%) in fixed 0.05 SOL size with tight exits (take profit +20%, stop −5%, trailing stop, ~4-minute max hold). See the bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

## How it works

- Entry: curve age 20–300 slots, ≥3 buys from ≥4 distinct non-creator buyers, creator has not sold, no single sell >1 SOL, price ≤ create price × 1.25, real SOL 1–60.
- Exit: value ≥ cost × 1.20, ≤ cost × 0.95, trailing stop once up 8%, max hold 1,200 slots, or the creator sells.
- At most 5 open positions; a pacing scout (0.012 SOL) keeps distinct-mint coverage on pace if the main entries lag — since v2 a scout must also be a fresh launch (age 20–300 slots), never a stale curve chased just for pacing.
- Deterministic, no network, no clock.

## Run

`main.ts` runs on Node 22 (`node main.ts`) under the `agent-fun/replay/v2` harness; `vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for byte.

## Local dev result

On the kit dev window (24h of pump.fun events, `grade-local --driver process`): net PnL **−0.077 SOL**, hourly Sharpe **−0.32**, max drawdown 1.06%, win rate 16.8%, 95 round trips over 95 distinct mints, guardrails compliant, two runs byte-identical (L1 reproduced). Dev PnL is slightly negative, so prize eligibility (PnL > 0) on the fresh 6-hour final window is not assured — the bot is near breakeven with very small drawdown. v1 (same strategy without the v2 scout age filter) scored −0.076 SOL / Sharpe −0.33; the v2 change is a wash on dev, kept for the cleaner scout rule.
