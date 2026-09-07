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

Recommended: Railway/Render/Fly.io with a persistent disk.

Set these worker variables:

```env
PORT=3001
PUBLIC_BASE_URL=https://your-worker.example.com
INTERNAL_API_KEY=change-me
DATA_DIR=/app/data
GHL_API_BASE=https://services.leadconnectorhq.com
GHL_VERSION=v3
GHL_CONVERSATION_PROVIDER_ID=YOUR_PROVIDER_ID
GHL_INBOUND_TYPE=SMS
GHL_CLIENT_ID=YOUR_GHL_CLIENT_ID
GHL_CLIENT_SECRET=YOUR_GHL_CLIENT_SECRET
GHL_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/ghl/callback
DISABLE_GHL_SIGNATURE=false
GHL_WEBHOOK_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
```

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
GHL_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/ghl/callback
GHL_INSTALL_URL=https://marketplace.gohighlevel.com/YOUR_INSTALL_URL
GHL_CONVERSATION_PROVIDER_ID=YOUR_PROVIDER_ID
GHL_INBOUND_TYPE=SMS
GHL_CLIENT_ID=YOUR_GHL_CLIENT_ID
GHL_CLIENT_SECRET=YOUR_GHL_CLIENT_SECRET
GHL_REDIRECT_URI=https://your-vercel-domain.vercel.app/api/ghl/callback
DISABLE_GHL_SIGNATURE=false
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
   `https://YOUR_VERCEL_DOMAIN/api/ghl/callback`
5. Create the client ID and client secret.
6. Configure the custom conversation provider in the Marketplace app.
7. Configure the provider as a custom **SMS** provider (the supported custom-channel path), enable the conversation tab, and set the provider delivery URL to:
   `https://YOUR_VERCEL_DOMAIN/api/ghl/outbound`
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
8. Outbound messages from the configured custom provider in HighLevel are forwarded to the worker and then to WhatsApp.

## Notes

- This is an MVP bridge, not a full clone of a commercial BSP, and it does not reproduce HighLevel's native WhatsApp channel.
- The worker uses Baileys, which is an unofficial WhatsApp Web integration. Review WhatsApp's terms and use it only in ways permitted by those terms. Baileys itself is not affiliated with WhatsApp.
- For production, replace the JSON store with Postgres/Redis, add rate limiting, audit logs, stricter tenant isolation, and a proper secret-management system.

For the exact click-by-click setup, see `DEPLOYMENT.md`.
