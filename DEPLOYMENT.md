# Deployment order

## A. HighLevel Developer Portal

1. Open https://marketplace.gohighlevel.com and enter **My Apps**.
2. Create a **Private** app for testing.
3. Choose **Sub-account** as the target user.
4. In Auth, create client ID/secret and add this redirect URL:
   `https://YOUR_VERCEL_DOMAIN.vercel.app/api/ghl/callback`
5. Add these scopes:
   - `conversations/message.write`
   - `conversations.readonly`
   - `conversations.write`
   - `contacts.readonly`
   - `contacts.write`
   - `conversations/message.readonly`
6. Configure a custom conversation provider. For this bridge, use the supported custom **SMS** provider path, enable the conversation tab, and set its Delivery URL to:
   `https://YOUR_VERCEL_DOMAIN.vercel.app/api/ghl/outbound`
7. Copy the provider ID shown by HighLevel and use it as `GHL_CONVERSATION_PROVIDER_ID`.
8. From **Manage → Versions**, create a test link for your app version and install it into your sandbox/test Location ID.

## B. Worker

Deploy `worker/` to a service that keeps a Node process alive and provides persistent storage. Railway, Render, Fly.io, or a VPS are suitable.

For Railway, create the service from this repository and set **Root Directory** to `/worker`. The worker directory includes a `railway.json` with its build, start, and `/health` settings. Do not deploy the repository root as the worker, because the root package is the Next.js web app.

Environment:

```env
INTERNAL_API_KEY=<long-random-secret>
DATA_DIR=/app/data
GHL_API_BASE=https://services.leadconnectorhq.com
GHL_VERSION=v3
GHL_CONVERSATION_PROVIDER_ID=<provider-id>
GHL_INBOUND_TYPE=SMS
GHL_CLIENT_ID=<client-id>
GHL_CLIENT_SECRET=<client-secret>
GHL_REDIRECT_URI=https://YOUR_VERCEL_DOMAIN.vercel.app/api/ghl/callback
GHL_WEBHOOK_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----
TOKEN_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
DISABLE_GHL_SIGNATURE=false
```

Generate the encryption key with:

```bash
openssl rand -base64 32
```

Attach a persistent disk mounted at `/app/data`. Without persistence, WhatsApp auth sessions are lost on restart.

## C. Vercel

Deploy the repo root as a Next.js project.

Environment:

```env
WORKER_URL=https://YOUR_WORKER_DOMAIN
WORKER_API_KEY=<same-as-worker>
NEXT_PUBLIC_APP_NAME=Spark WhatsApp Bridge
GHL_CLIENT_ID=<client-id>
GHL_CLIENT_SECRET=<client-secret>
GHL_REDIRECT_URI=https://YOUR_VERCEL_DOMAIN.vercel.app/api/ghl/callback
GHL_INSTALL_URL=<HighLevel-generated test/install URL>
GHL_CONVERSATION_PROVIDER_ID=<provider-id>
```

## D. First test

1. Open the Vercel URL.
2. Enter the Location ID.
3. Press **Connect GHL** and complete the HighLevel install.
4. Create an instance.
5. Press **Show QR**.
6. On the phone, open WhatsApp → Linked devices → Link a device.
7. Scan the QR.
8. Send a test WhatsApp message to that number.
9. The worker should upsert the contact and add an inbound message to HighLevel.
10. Reply from the configured HighLevel custom provider channel. The provider Delivery URL should hit `/api/ghl/outbound`, which forwards to the worker and then WhatsApp.
