# Anthropic Price Predictions

A small, self-hosted community prediction survey inspired by prediction-market interfaces. It uses **free, non-monetary predictions only**: no deposits, stakes, trading, payouts or prizes.

## Features
- Anonymous/nickname predictions in USD
- Community average, median, low/high and distribution
- Optional short explanation
- Private delete code returned to each participant and stored in that browser
- SQLite persistence in `data/market.db`
- Health endpoint at `/healthz`
- No external runtime dependencies; Node.js built-in `node:sqlite`

## Requirements and run
Node.js 22.5 or later.

```bash
npm start
```

The service listens on `0.0.0.0:8790` by default. Override with `PORT`.

Optional first-run settings:
- `MARKET_TITLE`
- `MARKET_DESCRIPTION`
- `MARKET_CLOSES_AT`

These are used only when the database is first created. To change an existing market, update the `markets` row in SQLite.

## Important
The default market asks for an indicative Anthropic share-price estimate, but the event, date and authoritative resolution source should be explicitly announced by the administrator before using the results as a scored forecast. This app is an opinion survey, not an exchange or financial product. It is not affiliated with Anthropic.
