# I'm at 1% — Live Battery Assistance (self-hosted server)

A real Node.js server for the app: no Firebase, no third-party backend.
Everyone who opens the site — from any device, anywhere — sees the same
live data (accounts, online status, requests, chat).

## What's inside
- `server.js` — Express API + WebSocket server + JSON-file storage (`data.json`, created automatically)
- `public/index.html` — the whole front-end (map, dashboard, requests, "Who To Help", chat, profile)
- Auth: email + password, hashed with bcrypt, sessions via JWT
- Realtime: a WebSocket pushes presence/request/message updates to every connected browser instantly

## Run it locally
```bash
npm install
npm start
```
Then open http://localhost:3000 — that's it, front-end and API are served from the same place.

## Deploy it for free (pick one)

### Render.com
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`  ·  Start command: `npm start`
4. Add an environment variable `JWT_SECRET` set to any long random string (Render can generate one).
5. Deploy. Render gives you a public `https://yourapp.onrender.com` URL — share that.

### Railway.app
1. Push to GitHub, then Railway → New Project → Deploy from GitHub repo.
2. Railway auto-detects Node and runs `npm start`.
3. Add the `JWT_SECRET` variable in the project's Variables tab.
4. Railway gives you a public URL under Settings → Networking.

### Fly.io / any VPS
Any host that runs `node server.js` and exposes `$PORT` works the same way —
`npm install && npm start`, set `JWT_SECRET`, done.

## Important notes
- **Data persistence**: data lives in `data.json` next to `server.js`. On Render/Railway's free tiers the filesystem is usually persistent between deploys but can reset on certain plan changes — for anything beyond a class project, swap the JSON file for a real database (Postgres is a drop-in upgrade later).
- **JWT_SECRET**: set this env var in production. If you don't, the server falls back to a default string, which is not secure for real use.
- **HTTPS**: hosts like Render/Railway give you HTTPS automatically. Location sharing (`navigator.geolocation`) requires HTTPS in most browsers, so use the hosted URL, not a plain `http://` address, once you're live.
- **Scale**: JSON-file storage is fine for tens to low hundreds of concurrent users (a class, a dorm, a campus pilot). For a larger public rollout, move `db.users/db.requests/db.messages` to Postgres/SQLite with an ORM — the API routes in `server.js` are already isolated so that's a contained change.
- **Security hardening left as next steps**: rate limiting on `/api/auth/*`, input validation beyond basic checks, password-reset flow, and HTTPS-only cookies instead of `localStorage` for the token if you want extra XSS resistance.

## API summary
| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/register | create account → `{token,user}` |
| POST | /api/auth/login | `{token,user}` |
| GET | /api/me | your profile |
| PUT | /api/me | update name/role/helperAvailable |
| POST | /api/location | update `{lat,lng}` (or `null` to stop sharing) |
| POST | /api/heartbeat | keep-alive (called every 25s by the front-end) |
| POST | /api/offline | mark yourself offline (sendBeacon on tab close) |
| GET | /api/users | everyone else's public profile/presence |
| GET | /api/requests | all assistance requests |
| POST | /api/requests | create a request |
| POST | /api/requests/:id/accept | helper accepts a request |
| GET | /api/messages?with=ID | conversation with one person |
| POST | /api/messages | send a message |
| WS | /ws?token=... | realtime push: `users:update`, `requests:update`, `message:new` |
