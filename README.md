# Friends Cooperative — WhatsApp Receipt Backend

Sends a member's PDF savings receipt directly into their WhatsApp chat using the
official **WhatsApp Business Cloud API** — no Android/Gmail/Viber share sheet,
no manual "choose an app" step. The admin clicks **📄 PDF পাঠান (WhatsApp)** in
the Friends Cooperative app; the PDF lands in the member's WhatsApp automatically.

```
friends-cooperative-whatsapp/
├── public/                 (optional — serve the app's static files from here if you want one deployment)
├── server/
│   ├── server.js           Express app + /api/send-receipt endpoint
│   ├── whatsapp.js         WhatsApp Cloud API calls (media upload + send document)
│   └── receipt.js          PDF validation, phone normalization, caption text
├── .env.example
├── package.json
└── README.md
```

## 1. WhatsApp Cloud API setup (Meta side)

1. Create a Meta App at [developers.facebook.com](https://developers.facebook.com/) and add the
   **WhatsApp** product.
2. Under WhatsApp → API Setup, note your:
   - **Phone number ID** → `WA_PHONE_NUMBER_ID`
   - **Temporary access token** (for testing) or generate a permanent token via a
     System User in Meta Business Settings → `WA_ACCESS_TOKEN`
   - Current **Graph API version** shown in the console → `GRAPH_API_VERSION`
3. Add and verify the WhatsApp Business phone number you'll send from.
4. **24-hour window:** WhatsApp only allows free-form messages (like a receipt
   document) within 24 hours of the member's last message to you. To message
   members outside that window, create and get Meta to **approve a message
   template** with a document header, then set `WA_TEMPLATE_NAME` in `.env` —
   the backend automatically falls back to the template when needed.
5. Each member's number must be stored in full international format (e.g.
   `974XXXXXXXX`) in the Friends Cooperative member record. The backend does
   **not** guess or prepend a country code.

## 2. Local setup

```bash
cd friends-cooperative-whatsapp
npm install
cp .env.example .env
# edit .env with your WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, GRAPH_API_VERSION,
# and a long random ADMIN_API_KEY
npm start
```

The server listens on `PORT` (default `3000`). Check it's alive:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"configured":true}
```

## 3. Connect the Friends Cooperative app

In the app: **Settings → WhatsApp Cloud API**

- **Backend URL** — where this server is reachable (e.g.
  `https://your-backend.example.com`, or `http://localhost:3000` for local testing).
- **Admin API Key** — the exact same value as `ADMIN_API_KEY` in `.env`.

Nothing else changes in the app. The existing **📄 PDF পাঠান (WhatsApp)** button on
each deposit/receipt row now calls this backend instead of opening the share sheet.
A small send-history table also appears on that same settings page.

## 4. Deployment

Any Node 18+ host works (Node 18 is required for built-in `fetch`/`FormData`).

**Render / Railway / Fly.io / a VPS:**
1. Push this folder to a Git repo (or deploy directly).
2. Set the build command to `npm install` and the start command to `npm start`.
3. Set the environment variables from `.env.example` in the host's dashboard —
   **never** commit the real `.env` file.
4. Once deployed, put the public HTTPS URL into the app's Settings → WhatsApp
   Cloud API → Backend URL. WhatsApp's Graph API requires your webhook/media
   calls to originate from a server reachable over HTTPS in production, and
   browsers will block calls from an HTTPS app page to a plain HTTP backend.

**Docker (optional):**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server ./server
EXPOSE 3000
CMD ["node", "server/server.js"]
```

## 5. Testing

**Health check:**
```bash
curl http://localhost:3000/api/health
```

**Send a real PDF (replace values):**
```bash
curl -X POST http://localhost:3000/api/send-receipt \
  -H "X-Admin-Key: YOUR_ADMIN_API_KEY" \
  -F "pdf=@/path/to/sample-receipt.pdf" \
  -F "phone=974XXXXXXXX" \
  -F "memberName=Motiur Rahman Fuhad" \
  -F "memberId=FC-2026-00026" \
  -F "receiptNumber=FC-2026-00042" \
  -F "month=জুলাই ২০২৬" \
  -F "amount=2000" \
  -F "paymentDate=10 সেপ্টেম্বর ২০২৬"
```
Expected success response:
```json
{ "success": true, "message": "PDF successfully sent to WhatsApp", "messageId": "wamid...." }
```

**From the app:** open a member's deposit row as admin, click **📄 PDF পাঠান
(WhatsApp)**. The button shows `⏳ পাঠানো হচ্ছে...`, then either a success alert
(`✅ ...`) or a Bangla error alert. Every attempt is recorded under Settings →
WhatsApp Cloud API, with a **🔄 আবার পাঠান** (resend) option afterward.

**Common errors you should be able to reproduce/verify:**
| Cause | What the admin sees |
|---|---|
| Wrong/missing `ADMIN_API_KEY` | `অননুমোদিত অনুরোধ (Unauthorized)।` |
| Missing/expired `WA_ACCESS_TOKEN` | `WhatsApp API configuration সমস্যা।` |
| Malformed member phone number | `সদস্যের WhatsApp নম্বর সঠিক নয়।` |
| Outside the 24h window, no template configured | `শেষ ২৪ ঘণ্টার মধ্যে সদস্যের সাথে কথোপকথন নেই — অনুমোদিত WhatsApp টেমপ্লেট প্রয়োজন।` |
| Backend unreachable | `ইন্টারনেট/API সংযোগ সমস্যা। আবার চেষ্টা করুন।` |

## Security notes

- `WA_ACCESS_TOKEN` lives **only** in the server's environment — it is never
  sent to, or readable from, the browser.
- `/api/send-receipt` requires the `X-Admin-Key` header to match `ADMIN_API_KEY`.
  Anyone without that key gets `401 Unauthorized`. Rotate this key if it ever
  leaks, and set `ALLOWED_ORIGINS` to your app's real domain in production
  instead of `*`.
- The PDF is processed in memory only and is never written to disk or logged.
