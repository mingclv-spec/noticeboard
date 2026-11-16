# 留言板 Noticeboard

A minimal public noticeboard: anyone can post a question, anyone can reply.

- Zero-dependency frontend (single HTML page)
- Node.js server, dual storage: PostgreSQL when `DATABASE_URL` is set, otherwise local SQLite
- Deploy target: Render (see `render.yaml`)

## Run locally

```bash
npm start          # http://localhost:8787  (SQLite)
```

## Deploy on Render

1. Push this repo to GitHub
2. Render → New → Blueprint → pick this repo → Apply
3. `render.yaml` creates the web service + a PostgreSQL database and wires `DATABASE_URL`
