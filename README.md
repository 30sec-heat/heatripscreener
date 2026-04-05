# heatripscreener

Chart + OI screener for **heat.rip** — **Velo** for historical and **live 1m** candles (polled only while a chart WebSocket client has that symbol subscribed), multi-venue USD OI from Velo, Binance **REST** for tickers + **open interest** (same rule: only symbols currently on screen). **No database**.

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
| `npm run ingest`    | Velo live poller + OI only (no HTTP / WS UI) |
| `npm run build:css` | Rebuild `app/styles.css` from Tailwind      |

## License

Proprietary — 30sec-heat.
