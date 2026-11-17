# Noticeboard

A minimal public noticeboard: anyone can post, anyone can reply. No accounts, no tracking.

- Zero-dependency frontend (single static HTML page, auto-refresh every 15s)
- Node.js server, dual storage: PostgreSQL when `DATABASE_URL` is set, otherwise local SQLite (`node:sqlite`)
- Per-post delete codes (anyone who posts gets a code to remove their own post) plus an admin token for the owner
- Limits: one post/reply up to 2000 chars, 20 writes per IP per 5 minutes
- Deploy target: Render (see `render.yaml`)

## Run locally

```bash
npm start          # http://localhost:8787  (SQLite, data/board.db)
```

Optional env:

| Var | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `8787`) |
| `DATABASE_URL` | Postgres connection string; set it to use Postgres instead of SQLite |
| `ADMIN_TOKEN` | Enables `x-admin-token` deletion without a delete code |

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/posts` | All posts with replies, newest first |
| `POST` | `/api/posts` | `{ name?, body }` → `201 { id, delete_code }` |
| `POST` | `/api/posts/:id/replies` | `{ name?, body }` |
| `DELETE` | `/api/posts/:id` | send `x-delete-code` (from the post response) or `x-admin-token` |

## Removing posts

Posters keep the `delete_code` they get back and send it in `x-delete-code`.
The owner can use the admin token instead:

```bash
curl -X DELETE https://your-app.onrender.com/api/posts/<id> \\
  -H "x-admin-token: $ADMIN_TOKEN"
```

Locally the admin token is stored in `.admin-token` (gitignored).

## Deploy on Render

1. Render → New → Blueprint → pick this repo → Apply
2. `render.yaml` creates the web service plus a free PostgreSQL instance and wires `DATABASE_URL`
3. Free instances sleep after ~15 minutes idle, so the first request may take ~50s

## Quick public URL without deploying

```bash
npm start &
cloudflared tunnel --url http://localhost:8787
```

The `trycloudflare.com` URL is temporary and changes on every restart.
