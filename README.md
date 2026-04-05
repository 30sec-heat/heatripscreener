# heatripscreener

Chart + OI screener for **heat.rip** — Binance-driven live bars, multi-venue USD open interest, net long/short panels. **No database**; history comes from Velo, live state is in memory.

## Run locally

```bash
npm install
npm run build:css      # only needed after editing app/css/input.css
npm run server         # http://localhost:4446
```

Optional: copy `.env.example` to `.env` if you override `PORT`.

## Railway

1. Create a project from [github.com/30sec-heat/heatripscreener](https://github.com/30sec-heat/heatripscreener).
2. **Start Command:** `npm start` (default).
3. Use **Railway → Networking → Auth** if you want password protection on the public URL.

`PORT` is set automatically; the server binds to `0.0.0.0`.

## Scripts

| Script              | Purpose                                      |
|---------------------|----------------------------------------------|
| `npm start`         | Production server (Railway)                  |
| `npm run server`    | Same                                         |
| `npm run ingest`    | Standalone Binance WS (no HTTP UI)         |
| `npm run build:css` | Rebuild `app/styles.css` from Tailwind      |

## License

Proprietary — 30sec-heat.
