# Schrift API

Backend API for the Schrift project: guilds, in-game accounts, scores, cycles/rotations, characters, score OCR, and Discord OAuth authentication. Serves the [Schrift front-end](../schrift) (React/Vite) and is deployed as a Vercel serverless function.

## Stack

- Node.js (ESM) + Express 5
- MongoDB (native `mongodb` driver, no ODM)
- JWT (`jsonwebtoken`) for auth
- `tesseract.js` for OCR on score screenshots
- Jest + Supertest for testing

## Getting started

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev             # nodemon, http://localhost:3000
```

### Environment variables

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection URI |
| `JWT_SECRET` | Secret used to sign JWTs |
| `FRONTEND_URL` | Extra CORS-allowed origin besides the front-end |
| `PORT` | HTTP port (dev only, defaults to 3000) |

Locally, the connection points to the `schrift-test` database; in production (`NODE_ENV=production`), to `schrift` (see `src/server.js`).

## Scripts

| Script | Effect |
|---|---|
| `npm run dev` | Dev server with reload (nodemon) |
| `npm start` | Starts `src/server.js` (used by cPanel/Passenger) |
| `npm test` / `npm run test:watch` | Jest tests (`tests/**/*.test.js`) |
| `npm run lint` | ESLint on `src/` |
| `npm run build` | Transpiles via Babel into `dist/` (cPanel deployment) |

## Structure

```
src/
  server.js         # classic Express entrypoint (cPanel/Passenger)
  routes/           # one router per domain, mounted in routes/index.js
  middleware/        # auth.js: requireAdmin, requireScoresAccess (JWT)
  services/          # heavier business logic (stats, score diffing, character sync)
  utils/             # helpers (bbsAccounts, pagination, regex, FTP, OCR...)
  config/            # DB connection
api/index.js         # alternative entrypoint for Vercel (serverless function)
tests/                # Jest tests, one folder per domain
dev/                  # one-off scripts (migrations, debugging, indexes) — not run in CI
scripts/              # data import/rebuild scripts (characters, guides...)
tools/attack-hits/    # Python extractor of the melee hit counts from the game model bundles
```

### Attack hits

The game tables only count the hits of projectiles. Melee hits are read from the animation events of the model bundles (`rmfs/<resource_3d_id>.byte`, plain Unity files): each hit window is one hit.

```
pip install -r tools/attack-hits/requirements.txt
python tools/attack-hits/extract_attack_hits.py <rmfs folder> attack_hits.csv [previous attack_hits.csv]
```

A dump only holds the models the client downloaded: pass the current `attack_hits.csv` as previous file so models missing from the new dump keep their hits (models found again are replaced).

Put `attack_hits.csv` at the root of the game data (`game-db/attack_hits.csv`), not in a language folder: uploading a new dump there then never removes it. The sync reads it when present; units whose model is missing from rmfs keep an unknown hit count.

Two entrypoints coexist: `src/server.js` (long-running process, listens on `PORT`, used for classic cPanel deployment) and `api/index.js` (serverless-adapted, caches the Mongo connection across invocations, used by `vercel.json`). Both mount the same `src/routes/index.js` router.

## Key data model: bbs accounts

A user (`users`) can have several linked in-game accounts (`bbs_accounts: [{ bbs_id, bbs_name, guilde_id, role, is_primary, linked_at }]`) — one primary account plus alts. Guild and role (`chef`/`sous-chef`/`membre`) live **per account**, not per user: the same Discord user can be a guild chief on one account and a plain member of another guild on an alt.

- Scores key on `{ bbs_id, cycle_id, rotation_id }` (not `user_id`), so each account keeps an independent history.
- The JWT carries a `guild_roles` array (one grant `{ bbs_id, guilde_id, role }` per chef/sous-chef account), used by `requireScoresAccess` to scope write access to the right guild.
- Guild rosters (`/guildes/:id/membres`) and the list of accountless users (`/users/without-guild`) return one row **per account**, not per user — see `src/utils/bbsAccounts.js`.
- Root-level mirror fields (`bbs_id`, `bbs_name`, `guilde_id`, `role`) are kept in sync with the primary account (`deriveMirrorFields`) for compatibility with older code/queries.

## Authentication

Login via Discord OAuth (code exchange handled in `routes/auth.js`), then a JWT is issued and expected as `Authorization: Bearer <token>` on protected routes. Guards (`src/middleware/auth.js`):
- `requireAdmin`: requires `is_admin` in the token.
- `requireAuth`: any logged-in user whose account still exists and is not banned.
- `requireScoresAccess`: admin, or a user with a chef/sous-chef account. Grants are read from the database on each request (not from the token), so a ban, demotion or guild change applies immediately. Routes then check the targeted guild with `canManageGuild(req.user, guildId)`.

Banning a user revokes their refresh token; `/auth/refresh` also rejects banned accounts.

## Deployment

- **Production**: Vercel, built via `api/index.js` (see `vercel.json`, 300s timeout for OCR).
- **Alternative cPanel**: `npm run build` (Babel → `dist/`) then `npm start` (Passenger detected via the `PhusionPassenger` global).
