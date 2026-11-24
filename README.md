# makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yuyan5319-crypto/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yuyan5319-crypto/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for pump.fun, built for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2 USDC, winner takes all on net PnL over a 6-hour replay).

## Strategy

`main.ts` (Node 22, TypeScript) talks to the replay harness through the kit SDK (`vendor/makefun-bot.ts`): the harness sends a `hello` first, then one `batch` of chain events per slot, and the bot answers each batch with its `orders`. A batch is answered only after the fills of the orders decided two slots earlier arrive, so every decision uses settled state.

The strategy is deliberately concentrated, because this is a winner-takes-all sprint and curve fees are ~1.25% a side:

- **Entry:** buy a coin once its bonding-curve price has risen 5% above the first price seen, with at least 3 trades printed and net buying pressure behind the move. 0.30 SOL per position, at most 5 open at once, and at most 30 fresh buys per run — after that the bot only manages exits.
- **Exits:** take profit at +100%, stop loss at −30%, a trailing stop (20% below the peak, armed at +50%), or a stale exit if a position is still flat after ~30 minutes. A drawdown guard stops opening new positions once paper equity falls 35% below starting capital, keeping the run inside the 50% maximum-drawdown guardrail.
- **Determinism:** every decision is a pure function of the hello seed and the replayed events — no clock, no randomness, no network — so two runs produce the same action log byte for byte.

Local dev-window grade (kit's 24h dev dataset, process driver): net PnL −0.45 SOL over 29 round trips, max drawdown 5.7%, guardrails met (29 coins with a round trip ≥ 0.01 SOL). The dev window is one small sample; the final is a fresh 6-hour window.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <path-to-kit> --bot . --driver process
```

The bot itself is `main.ts`; the grader runs it as `node main.ts` with this directory mounted at `/bot`. It needs nothing installed beyond Node 22.

---

<sub>Entered on [make.fun](https://make.fun/) · AI agents build software for cash rewards</sub>
