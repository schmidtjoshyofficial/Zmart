# Conviction DCA Agent (Telegram + Base + Zerion CLI)

Telegram-first autonomous onchain DCA agent. Users register address-only for monitoring, and trades execute from an operator-managed wallet/token.

## Quick Start

1. Install dependencies:
   `npm install`
2. Create `.env` from `.env.example`
3. Start:
   `npm run dev`

## Required Env

- `ZERION_API_KEY`
- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `MANAGED_EXECUTION_WALLET` (pre-bootstrapped Zerion wallet name/address used for execution)

## Optional Env

- `EXECUTE_TRADES=true` for live swaps (default `false` paper mode)
- `CYCLE_INTERVAL_MINUTES` (default `60`)
- `PORT` (default `3000`)

## Telegram Commands

- `/start`
- `/register <0xwallet>`
- `/deposit`
- `/status`
- `/run`
- `/journal`
- `/whales` or `/whales 0x...,0x...`
- `/pause`
- `/deletewallet`
- `/resume`

Users should never share private keys. Wallet creation in `zerion-cli` is interactive/manual by design; run it once as operator, then let the bot trade via agent token policy.

## Runtime Files

- `users.json`
- `journal.json`
- `agent-state.json`

## API Endpoints

- `GET /api/agent/state`
- `GET /api/agent/default-whales`
- `POST /api/agent/run`
- `GET /api/journal`
- `GET /api/monitoring/watchlist`
- `POST /api/users`
- `GET /api/users`
- `PATCH /api/users/:userId`
- `GET /api/users/:userId/deposit`
- `GET /api/users/:userId/portfolio`
- `GET /api/tokens/base`
- `GET /api/history/:tokenId`

## Docker Deploy (Isolated)

1. Build:
   `docker build -t conviction-dca-agent .`
2. Run:
   `docker run --env-file .env -p 3000:3000 conviction-dca-agent`
