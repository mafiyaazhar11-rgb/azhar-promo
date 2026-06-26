# AZHAR Promo — Setup & Deploy Guide

Built the same way as your other apps: Node.js/Express, PostgreSQL (your existing
azhar-ai-db), JWT login, Anthropic API, deployed on Render. Everything below can be
done from the browser — GitHub web interface + Render dashboard, no installs needed.

## 1. Create the GitHub repo

1. Go to github.com, log in as mafiyaazhar11-rgb
2. Create a new repository, e.g. `azhar-promo`
3. Upload these files using "Add file" → "Upload files" in the GitHub web interface:
   - `server.js`
   - `package.json`
   - `schema.sql`
   - `public/index.html`
   - `.env.example` (just for reference, real secrets go in Render's dashboard, not in GitHub)

## 2. Run the database schema once

1. Go to your Render dashboard → azhar-ai-db → "Connect" → copy the **External Database URL**, or use Render's built-in web Shell/Query tool if your plan includes one
2. Open the SQL query tool (Render's dashboard has a basic one, or you can run schema.sql through any browser-based Postgres client you already use for your other apps)
3. Paste the contents of `schema.sql` and run it once. This creates the new `promo_*` tables and seeds your 4 existing products.

## 3. Create the Render Web Service

1. Render dashboard → "New" → "Web Service"
2. Connect the `azhar-promo` GitHub repo
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Starter ($7/month, same as your other apps) — or check if your existing AZHAR-AI service has spare capacity to add this as a second service on the same plan tier
4. Environment variables (Render dashboard → Environment tab):
   - `DATABASE_URL` → same connection string as your other apps use for azhar-ai-db
   - `JWT_SECRET` → any long random string (you can generate one at render.com or just type a long random sentence)
   - `ANTHROPIC_API_KEY` → your Anthropic API key (same one used elsewhere, or a separate one if you prefer to track this app's usage separately)
5. Deploy

## 4. First-time login setup

1. Open your new Render URL (e.g. `azhar-promo.onrender.com`)
2. Click "Create the shared login" on the login screen
3. Choose a username and password — this becomes the one shared login for you and your wife
4. Log in

**Important:** the `/api/auth/setup` route only works once — it blocks itself after the first user is created, so there's no risk of someone else creating an account later.

## 5. Add your products (already seeded, but check them)

The schema.sql already seeds BrightMind Teacher, IND-Sugar Care, AZHAR-AI, and Binance
Trading Bot with starting details. Go to the Products tab and review/edit them to make
sure the descriptions match how you'd actually want them marketed — the AI uses exactly
what's written there every time it generates content.

## 6. Day-to-day use (for your wife)

1. Log in with the shared username/password
2. Generate tab → pick product, platform, content type → Generate
3. Tap the caption she likes → Save to library
4. Copy the caption + hashtags, post manually on Instagram/Facebook/TikTok
5. Mark it "Posted" in the Library tab once it's live

No auto-posting, no API approval waiting — works the moment it's deployed.
