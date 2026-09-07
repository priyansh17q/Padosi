# Padosi Pro — Kaam ho jaayega, pados se hi

Hyperlocal task marketplace. Koi apna chhota kaam post karta hai (saman upar le jaana,
laundry, chhoti errand, parcel bhejna, ya kuch khareedwaana), area ke log usko accept
karke kama sakte hai. Padosi har completed + paid task pe automatically commission
cut karta hai (default 10%, `COMMISSION_PERCENT` se change kar sakta hai).

## What's new in this version
- **New visual identity** — indigo/violet + teal + amber + rose + emerald color system,
  with a full **dark/light mode toggle** (persists across sessions).
- **Lamp pull-string login** — pull the cord to reveal the sign-in form, with a warm
  glow and floating particles.
- **"Bead" bottom navigation** — each tab (Feed, Post, My tasks, Wallet, Profile) has
  its own accent color; the active tab pops up in a glowing circle.
- **Payment methods** — save a UPI ID or a card for faster checkout, with a live
  animated card preview that flips to show the CVC field. **Security note:** we never
  store a full card number or CVC — only the brand + last 4 digits + expiry, purely
  for display. Real charges always go through Razorpay's own secure checkout.
- **Send item / Buy for me** task categories, alongside delivery/laundry/cleaning/etc.
- **Real-time feed** — Socket.IO pushes new tasks and status changes instantly.
- **Notifications, reviews & ratings** on both sides of a completed task.
- **Security hardening** — Helmet security headers, configurable CORS origin,
  brute-force rate limiting scoped correctly (so it can't lock out multiple genuine
  users sharing one office/home WiFi), and a stricter limit specifically on the
  card-add endpoint to block card-testing abuse.
- **Load-tested** — `backend/loadtest.js` simulates 20 concurrent users signing up,
  browsing, posting/accepting tasks, and saving payment methods. Included so you can
  re-run it any time you change something.

## Stack
- **Backend:** Node.js + Express + SQLite (`better-sqlite3`) + Socket.IO + Helmet
- **Auth:** JWT (phone + password, bcrypt-hashed)
- **Payments:** Razorpay (Orders API + signature verification + webhook)
- **Frontend:** Vanilla HTML/CSS/JS PWA (served by the same Express server), separate
  animated landing page — no heavy external animation libraries, so it stays fast and
  doesn't break if a CDN is slow or blocked.

## Don't have a PAN yet? Use Mock Payment Mode

If you don't have a PAN card (Razorpay now asks for one during signup, even
for Test Mode), you don't have to wait to launch. Set this in your `.env`:
```
MOCK_PAYMENTS=true
```
The **entire app** — post, accept, complete, pay, wallet credit, everything —
works end-to-end with zero signup, PAN, or KYC anywhere. Payments are
simulated instantly (no real gateway is called at all). A visible orange
"TEST MODE" banner appears across the app so nobody mistakes it for a real
transaction.

Once you have real Razorpay keys (from a PAN — your own via
[Instant e-PAN](https://www.incometax.gov.in) in ~10 minutes if you have
Aadhaar, or a trusted family member's for now), just set `MOCK_PAYMENTS=false`
and add the real `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` — no code changes,
no redeploy logic needed, just update the Railway environment variables.

## How the money flow works
1. Poster creates a task with a price (e.g. ₹20).
2. A nearby tasker accepts it and does the work.
3. Tasker marks it "done" → poster gets a notification.
4. Poster pays via Razorpay checkout (real payment).
5. Backend verifies the Razorpay signature, then:
   - Credits `payout_amount` (price − commission) to the tasker's in-app wallet
   - Records the commission in the `transactions` table — that's your cut
   - Sends the tasker a "payment received" notification
6. Wallet balance/history visible under the "Wallet" tab; either side can leave a
   review once paid; saved UPI/card methods speed up future checkouts.

> Note: this MVP credits taskers to an **in-app wallet** rather than auto-transferring
> real money to their bank account. Actually paying taskers out to real bank
> accounts/UPI requires Razorpay Route or Razorpay X (needs additional KYC approval
> from Razorpay). The wallet ledger here already tracks exactly who is owed how much.

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
- `JWT_SECRET` — any long random string
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — from your Razorpay Dashboard → Settings → API Keys
- `RAZORPAY_WEBHOOK_SECRET` — set a secret, then add the same one when you create a webhook in Razorpay Dashboard → Webhooks, pointing to `https://yourdomain.com/api/payments/webhook`, subscribed to `payment.captured`
- `COMMISSION_PERCENT` — your cut, e.g. `10`
- `CORS_ORIGIN` — leave unset for local dev; once deployed, set this to your real domain (see deployment section)

Run it:
```bash
npm start
```

Open `http://localhost:4000` for the app, `http://localhost:4000/landing` for the marketing page.

### Running the load test
With the server running in one terminal, in another terminal:
```bash
cd backend
node loadtest.js
```
This fires realistic traffic from 20 simulated users and reports pass/fail, response
times, and whether the server survived. Safe to run against a local dev server;
don't point it at production with real user data.

## Deploying (Railway, with persistent data)

This backend already serves the frontend (same Express server), so you only
need **one deployment**.

1. **Push to GitHub**
   ```bash
   cd padosi-pro-v2
   git init && git add . && git commit -m "Padosi Pro"
   git remote add origin https://github.com/TarunKumar2531/padosi.git
   git branch -M main && git push -u origin main
   ```

2. **Deploy on Railway** — [railway.app](https://railway.app) → New Project →
   Deploy from GitHub repo → in Settings, set **Root Directory** to `backend`.

3. **Add a persistent Volume** — Settings → Volumes → New Volume, mount path
   `/data`. Then in **Variables**, set:
   ```
   DB_PATH=/data/padosi.sqlite
   ```

4. **Set the rest of the environment variables** (Variables tab):
   ```
   JWT_SECRET=<a long random string>
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=<your Razorpay secret>
   RAZORPAY_WEBHOOK_SECRET=<any secret string, reuse it in step 6>
   COMMISSION_PERCENT=10
   ```

5. **Generate a public domain** — Settings → Networking → Generate Domain.

6. **Set CORS_ORIGIN to your real domain** once you have it (Variables tab):
   ```
   CORS_ORIGIN=https://your-actual-domain.up.railway.app
   ```
   This stops other websites from calling your API directly.

7. **Connect the Razorpay webhook** — Razorpay Dashboard → Account & Settings
   → Webhooks → Add New Webhook:
   - URL: `https://YOUR-DOMAIN/api/payments/webhook`
   - Secret: same value as `RAZORPAY_WEBHOOK_SECRET`
   - Event: `payment.captured`

8. **Test end to end** with Razorpay **test mode** keys first (signup → post
   task → accept → complete → pay → review). Then switch to live keys and redeploy.

Socket.IO real-time layer works over the same domain/port automatically — no
extra Railway config needed.

## Security notes
- Passwords are bcrypt-hashed; never stored in plain text.
- JWTs expire after 30 days; keep `JWT_SECRET` private and never commit it.
- Payment methods store only card brand + last 4 digits + expiry — never the full
  number or CVC. Actual charges go through Razorpay's PCI-compliant checkout.
- Helmet sets standard security headers (clickjacking protection, MIME-sniffing
  protection, etc).
- Rate limiting: a generous global limit against abuse, a tighter limit specifically
  on signup/login (brute-force protection), and an even tighter one on the card-add
  endpoint (to block automated card-testing).
- Once you have a real domain, set `CORS_ORIGIN` so only your own frontend can call
  the API.
- If you ever accidentally share a `.env` value, API key, or `JWT_SECRET` anywhere
  (chat, GitHub, screenshots), rotate it immediately — treat it like a password.

## Project structure
```
padosi-pro-v2/
├── backend/
│   ├── server.js          # Express + Socket.IO entry point, security middleware
│   ├── loadtest.js         # 20-concurrent-user load test script
│   ├── db/db.js            # SQLite schema + connection + migrations
│   ├── middleware/auth.js  # JWT check
│   └── routes/
│       ├── auth.js         # signup/login/profile (rate-limited)
│       ├── tasks.js        # post/list/accept/complete/review
│       └── payments.js     # Razorpay order/verify/webhook/wallet/payment methods
└── frontend/
    ├── index.html          # premium mobile-first PWA app
    ├── landing.html         # animated marketing page (no heavy external libs)
    ├── manifest.json        # PWA manifest
    ├── sw.js                 # service worker
    ├── icon-192.png / icon-512.png
```

## What to build next
- Razorpay Route integration for direct-to-bank tasker payouts
- Push notifications (browser Push API) instead of in-app polling only
- Admin dashboard to see total commission earned across all tasks
- Task photo uploads (currently only an `image` URL field exists on the schema)
- In-app chat between poster and tasker
