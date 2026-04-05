# heatripscreener

Chart + OI screener for **heat.rip** — Binance-driven live bars, multi-venue USD open interest, net long/short panels.

## Run locally

```bash
npm install
npm run build:css      # only needed after editing app/css/input.css
cp .env.example .env   # optional
npm run setup-db       # creates DB `heatrip` (Postgres)
npm run server         # http://localhost:4446
```

## Railway

1. Create a project from [github.com/30sec-heat/heatripscreener](https://github.com/30sec-heat/heatripscreener).
2. Add a **PostgreSQL** plugin and copy its **`DATABASE_URL`** into the web service variables.
3. Set the **Start Command** to `npm start` (default if `package.json` has `start`).
4. Apply schema: run `scripts/setup-db.sql` against the Railway DB (e.g. from your machine with the connection string, or Railway’s SQL console).
5. Use **Railway → Networking → Auth** if you want password protection on the public URL.

`PORT` is set automatically; the server binds to `0.0.0.0`.

## Scripts

| Script        | Purpose                                      |
|---------------|----------------------------------------------|
| `npm start`   | Production server (Railway)                  |
| `npm run server` | Same                                     |
| `npm run ingest` | Standalone Binance ingestion              |
| `npm run build:css` | Rebuild `app/styles.css` from Tailwind |

## License

Proprietary — 30sec-heat.
