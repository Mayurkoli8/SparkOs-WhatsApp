# GHL WhatsApp Bridge

A self-hosted WhatsApp Web bridge with a Vercel dashboard and a long-running Baileys worker.

## What this project does

- Add a HighLevel sub-account (Location ID) in a dashboard.
- Create a WhatsApp instance for that location.
- Show a QR code and pair the WhatsApp account by scanning it.
- Keep the WhatsApp session on a persistent worker disk.
- Receive WhatsApp messages and push them into a HighLevel custom Conversation Provider channel.
- Receive HighLevel provider outbound events and send them through WhatsApp.
- Keep GHL OAuth tokens on the worker, encrypted at rest.

## Important HighLevel limitation

HighLevel's current public custom Conversation Provider documentation covers custom SMS, Email, and Call providers. WhatsApp is also a native HighLevel channel. This starter therefore uses the supported **custom provider** mechanism and routes WhatsApp traffic through that provider; it does **not** turn the number into HighLevel's native WhatsApp provider. If you require the native WhatsApp channel, use HighLevel's native WhatsApp onboarding instead of a custom provider.

## Important deployment architecture

**Do not run Baileys as a normal Vercel-only API function.** A WhatsApp Web session is a long-lived WebSocket connection. Vercel Functions are request-oriented and have execution-duration limits. This project intentionally splits the system:

- `/` -> Next.js dashboard + GHL OAuth + webhook proxy, deployed to Vercel.
- `worker/` -> Express + Baileys, deployed to a long-running Node host such as Railway, Render, Fly.io, or a VPS. Give it persistent storage for `worker/data/`.

This keeps the public site on Vercel while the WhatsApp sessions remain alive.

## 1. Deploy the worker first

Recommended: Railway/Render/Fly.io with a persistent disk. For Railway, set the service **Root Directory** to `/worker`; the repository root is the separate Next.js web app. The worker includes `worker/railway.json` for its build, start, and `/health` health check settings.

Set these worker variables:

```env
INTERNAL_API_KEY=change-me
DATA_DIR=/app/data
GHL_CONVERSATION_PROVIDER_ID=YOUR_PROVIDER_ID
GHL_CLIENT_ID=YOUR_GHL_CLIENT_ID
GHL_CLIENT_SECRET=YOUR_GHL_CLIENT_SECRET
GHL_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/oauth/callback
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
```

Optional: `GHL_INBOUND_TYPE` (default `SMS`), `SYNC_PHONE_MESSAGES` (default `true`, mirrors messages typed on the phone into GHL), `SEND_MIN_INTERVAL_MS` (default `1200`, spacing between WhatsApp sends), `MAX_MEDIA_MB` (default `16`), `GHL_WEBHOOK_PUBLIC_KEY` (defaults to HighLevel's published Ed25519 key). Do not set `GHL_VERSION`; the worker sends the API version each HighLevel endpoint requires. Never set `DISABLE_GHL_SIGNATURE=true` in production.

Attach a Railway volume and mount it at `/app/data` (or wherever `DATA_DIR` points). Without it, every redeploy logs WhatsApp out and forgets the HighLevel token.

Then:

```bash
cd worker
npm install
npm run build
npm start
```

## 2. Deploy the web app to Vercel

Set:

```env
WORKER_URL=https://your-worker.example.com
WORKER_API_KEY=change-me
NEXT_PUBLIC_APP_NAME=Spark WhatsApp Bridge
GHL_CLIENT_ID=YOUR_GHL_CLIENT_ID
GHL_CLIENT_SECRET=YOUR_GHL_CLIENT_SECRET
GHL_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/oauth/callback
GHL_INSTALL_URL=https://marketplace.gohighlevel.com/YOUR_INSTALL_URL
GHL_CONVERSATION_PROVIDER_ID=YOUR_PROVIDER_ID
```

Then connect your custom domain if needed.

## 3. Configure the HighLevel Marketplace app

In HighLevel Developer Marketplace:

1. Create a Marketplace App. Start as **Private**.
2. Target user: **Sub-account**.
3. Add the OAuth scopes required for custom conversation providers:
   - `conversations/message.write`
   - `conversations.readonly`
   - `conversations.write`
   - `contacts.readonly`
   - `contacts.write`
   - `conversations/message.readonly`
4. Set the OAuth redirect URL to:
   `https://YOUR_VERCEL_DOMAIN/api/oauth/callback`
5. Create the client ID and client secret.
6. Configure the custom conversation provider in the Marketplace app.
7. Configure the provider as a custom **SMS** provider (the supported custom-channel path), enable the conversation tab, and set the provider delivery URL to:
   `https://YOUR_VERCEL_DOMAIN/api/oauth/outbound`
8. Copy the resulting `conversationProviderId` into the Vercel and worker environment variables.
9. Generate the app installation/test link from the app version and install it into your test Location ID.

## 4. Use the dashboard

1. Open the Vercel site.
2. Add the GHL Location ID.
3. Click **Connect GHL** and finish the HighLevel installation flow.
4. Create an instance.
5. Click **Show QR**.
6. Scan the QR from WhatsApp > Linked devices.
7. When the instance becomes Connected, inbound messages should be forwarded to HighLevel.
8. Outbound messages from the configured custom provider in HighLevel are forwarded to the worker and then to WhatsApp. Delivered/read receipts update the message status in HighLevel; failures are marked failed with the reason.

## Admin, sub-accounts and multiple numbers

- `/admin` (password: Vercel `ADMIN_PASSWORD`) shows every sub-account, number, health check, the worker's memory and disk, and the activity log.
- `/subaccount/<locationId>` is the sub-account's own page; add it in the agency as a Custom Menu Link `https://<vercel-domain>/subaccount/{{location.id}}`. Sub-accounts add, name, reconnect and remove their numbers there, up to the limit set in admin (default 5).
- Routing: a `{WA#2}` / `{WA:Sales}` / `{WA:+91…}` token in a message, else the contact's `wa: +number` tag (kept on the number they last talked to), else the number whose owner the contact is assigned to, else the sending user's number, else the default number. If that number is offline the message waits (60 s by default), then goes from another connected number.
- Contact owner (admin → Sub-accounts → Manage): contacts who talk to a number are assigned to the HighLevel user set on it, either only when they have no owner yet or always. Picking the user from a list needs the `users.readonly` scope on the Marketplace app; without it a user ID can be pasted.
- Number protection: people who wrote first can always be answered. Starting chats with people who never wrote is limited per number: new chats a day (30), a warm-up for newly linked numbers (7 days at 10 a day), and messages to someone who has not replied (3). Change the defaults on the admin **Settings** tab, or per number under **Manage**: skip or restart the warm-up, make it shorter or longer, change the limits, or turn protection off. The worker env (`NEW_CHATS_PER_DAY`, `WARMUP_DAYS`, `WARMUP_NEW_CHATS_PER_DAY`, `COLD_MESSAGES_PER_CONTACT`, `FAILOVER_WAIT_SECONDS`, `SEND_MIN_INTERVAL_MS`) only sets the starting values. When WhatsApp restricts a number (error 463 / reach-out timelock) it stops starting new chats until the restriction ends, even with protection off, and that outreach is not moved to other numbers; **Clear and check with WhatsApp** asks WhatsApp again. Sends use a typing indicator, randomised pauses, and read receipts.
- Reliability: WhatsApp messages HighLevel does not accept right away (outage, rate limit, token trouble) wait in a retry queue on disk and are retried for up to a day; HighLevel API calls are retried on rate limits and outages; each HighLevel message is sent to WhatsApp once, even if its webhook repeats; the delivery URL waits for a restarting worker for up to 25 s.
- Alerts (admin → Settings): an https webhook (for example a HighLevel workflow with the Inbound Webhook trigger) gets a JSON alert when a number is logged out, banned, restricted or offline for 10 minutes, or a message could not be synced or delivered.

These limits lower the risk of Meta restrictions; no WhatsApp Web based bridge can rule them out. Only Meta's official WhatsApp Business Platform is free of that risk.

## Troubleshooting

The dashboard's **Setup status** panel checks the configuration on both Vercel and the worker (API key, provider ID, OAuth client, persistent storage, signature verification, HighLevel connection, WhatsApp connection). The **Activity** panel lists every sync attempt and the exact HighLevel error when one fails. `GET /api/health` shows which worker build is running.

## Notes

- This is an MVP bridge, not a full clone of a commercial BSP, and it does not reproduce HighLevel's native WhatsApp channel.
- The worker uses Baileys, which is an unofficial WhatsApp Web integration. Review WhatsApp's terms and use it only in ways permitted by those terms. Baileys itself is not affiliated with WhatsApp.
- For production, replace the JSON store with Postgres/Redis, add rate limiting, audit logs, stricter tenant isolation, and a proper secret-management system.

For the exact click-by-click setup, see `DEPLOYMENT.md`.
