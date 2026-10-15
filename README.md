# webandappmakers — Instagram comment + DM auto-reply

Multi-tenant SaaS: any user connects their own Instagram Business/Creator account and sets up
auto-reply rules. Replies to **comments** (public reply + private DM) and now to **incoming DMs**.

## What's new
- **Incoming DM auto-reply.** When someone DMs the connected account, a matching rule fires and
  the app replies in the DM thread. Rules have a **Channel** (Comments + DMs / Comments only / DMs only)
  so you can control where each one runs.

## Follow gate (two-step)
Turn on **Follow gate** on any rule. Step 1 sends a Follow button (links to your profile) and the
main message is withheld. When the person messages you again (after tapping Follow), the held main
message is released automatically. **Instagram's API cannot verify a real follow** — the release is
triggered by their next reply, which is the only "came back after following" signal Meta exposes.

## Stack
Node + Express + better-sqlite3 + express-session. One SQLite file per deployment, one row per
connected account.

## Setup (quick)
1. Create a Meta app at developers.facebook.com → add **Instagram** + **Facebook Login** products.
2. Copy `.env.example` → `.env` and fill `APP_ID`, `APP_SECRET`, `VERIFY_TOKEN`, `BASE_URL`, `SESSION_SECRET`.
3. `npm install && npm start` (Node 18+).
4. Deploy on Render using `render.yaml` (free tier + 1 GB disk for the SQLite file).
5. In the Meta app, set the Webhook callback to `https://YOUR-URL/webhook`, verify token = `VERIFY_TOKEN`,
   and subscribe the fields **comments** and **messages**.
6. Open the app → **Connect Instagram** → approve → add rules.

## Permissions / review
- Comment auto-reply uses `instagram_manage_comments`.
- **DM auto-reply uses `instagram_manage_messages`.** This works for your own app's admins/testers in
  Development mode immediately. To reply to the public, Meta requires App Review + Business Verification
  for `instagram_manage_messages`, and incoming-DM automation is subject to Meta's 24-hour messaging window
  and human-agent policies.

## How rules match
Keyword rules are checked first (substring, case-insensitive). If none match, a rule of type
"Everything" (if enabled) catches the rest. Each rule can post a public comment reply, send a DM, or both.
De-duplication is by comment id / message id, so the same event never triggers twice.
