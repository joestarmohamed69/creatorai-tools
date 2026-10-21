# CreatorAI Studio

Zero-dependency Node.js app (Node 22.5+): SQLite database, server-side AI, accounts, free limits, admin.

## Run locally
1. `cp .env.example .env` and set `AI_API_KEY` (**REQUIRES CONFIGURATION**)
2. `npm start` → http://localhost:3000   (`npm test` runs the checks)

## Deploy (Render / Railway / Fly)
- Build: none. Start: `npm start`. Node 22+.
- Set env vars from `.env.example` (never commit `.env`).
- SQLite needs a **persistent disk**: mount one and set `DB_PATH=/disk/app.db`.
- Make yourself admin: set `ADMIN_EMAIL` to your email, then sign up with it.

## Change things later
- Limits/prices: `lib/plans.js`
- AI provider/prompts: `lib/ai.js` (add a function to `providers`)
- Payments: `lib/payments.js` (**REQUIRES CONFIGURATION**, Stripe not wired yet)
