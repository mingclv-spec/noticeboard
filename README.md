# 留言板 Noticeboard

A minimal public noticeboard: anyone can post a question, anyone can reply.

- Zero-dependency frontend (single HTML page)
- Node.js server, dual storage: PostgreSQL when `DATABASE_URL` is set, otherwise local SQLite
- Deploy target: Render (see `render.yaml`)

## Run locally

```bash
npm start          # http://localhost:8787  (SQLite)
```

## Removing posts

Set `ADMIN_TOKEN` and send it as a header:

```bash
curl -X DELETE https://your-app.onrender.com/api/posts/<id> \
  -H "x-admin-token: $ADMIN_TOKEN"
```

Locally the token is stored in `.admin-token` (gitignored).

## Deploy on Render

1. Push this repo to GitHub
2. Render → New → Blueprint → pick this repo → Apply
3. `render.yaml` creates the web service + a PostgreSQL database and wires `DATABASE_URL`
