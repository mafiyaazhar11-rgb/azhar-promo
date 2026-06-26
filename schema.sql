-- AZHAR Promo — Database schema
-- Run this once against your existing azhar-ai-db (Render PostgreSQL)
-- These are NEW tables, prefixed "promo_" so they never collide with
-- your other apps' tables (brightmind, azhar-ai, binance-bot) in the same DB.

CREATE TABLE IF NOT EXISTS promo_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  short_description TEXT,
  target_audience TEXT,
  key_features TEXT,
  tone_notes TEXT,
  pricing_info TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_posts (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES promo_products(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL,       -- facebook | instagram | tiktok
  content_type VARCHAR(50) NOT NULL,   -- new_feature | testimonial | pricing_offer | daily_tip | whatsapp_group | poster_text
  target_audience VARCHAR(50),         -- parents | students | tuition_teachers | school_groups | exam_prep_students
  marketing_angle VARCHAR(50),         -- tuition_cost | language_problem | exam_fear | homework_help | parent_peace_of_mind | free_trial | tuition_comparison
  output_language VARCHAR(30),         -- english | tamil | malayalam | hindi | tamil_english_mix | malayalam_english_mix
  caption TEXT,
  hashtags TEXT,
  voiceover_script TEXT,
  shot_list TEXT,
  hooks TEXT,                          -- 5 generated hook lines, newline-separated
  versions JSONB,                      -- { emotional, direct_sales, reel_caption, whatsapp_message, ad_copy }
  status VARCHAR(20) DEFAULT 'draft',  -- draft | posted | used_for_ad
  performance_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  posted_at TIMESTAMP
);

-- Additive migration for databases that already have promo_posts from before
-- this upgrade. Safe to run repeatedly — IF NOT EXISTS guards every column.
ALTER TABLE promo_posts ADD COLUMN IF NOT EXISTS target_audience VARCHAR(50);
ALTER TABLE promo_posts ADD COLUMN IF NOT EXISTS marketing_angle VARCHAR(50);
ALTER TABLE promo_posts ADD COLUMN IF NOT EXISTS output_language VARCHAR(30);
ALTER TABLE promo_posts ADD COLUMN IF NOT EXISTS hooks TEXT;
ALTER TABLE promo_posts ADD COLUMN IF NOT EXISTS versions JSONB;

CREATE INDEX IF NOT EXISTS idx_promo_posts_product ON promo_posts(product_id);
CREATE INDEX IF NOT EXISTS idx_promo_posts_status ON promo_posts(status);
CREATE INDEX IF NOT EXISTS idx_promo_posts_audience ON promo_posts(target_audience);

-- Weekly content calendar: one row per planned day.
CREATE TABLE IF NOT EXISTS promo_calendar (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES promo_products(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,       -- the Monday this week plan belongs to
  day_of_week VARCHAR(10) NOT NULL,    -- Monday | Tuesday | ... | Sunday
  content_idea TEXT,
  platform VARCHAR(20),
  caption_idea TEXT,
  cta TEXT,
  linked_post_id INTEGER REFERENCES promo_posts(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_calendar_week ON promo_calendar(product_id, week_start_date);

-- Ensure product names are unique so ON CONFLICT below actually works,
-- and so re-running this file never creates duplicate products again.
-- This also removes any duplicates that may already exist from before
-- this constraint was added, keeping only the earliest row per name.
DELETE FROM promo_products a USING promo_products b
  WHERE a.name = b.name AND a.id > b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promo_products_name_unique'
  ) THEN
    ALTER TABLE promo_products ADD CONSTRAINT promo_products_name_unique UNIQUE (name);
  END IF;
END $$;

-- Seed your existing products so you don't have to type them in by hand.
-- Edit these details any time from the Products screen in the app.
INSERT INTO promo_products (name, short_description, target_audience, key_features, tone_notes, pricing_info)
VALUES
(
  'BrightMind Teacher',
  'AI tutor web app for CBSE and Tamil Nadu State Board students, Classes 9-12',
  'Parents of school students in India, CBSE and Tamil Nadu Samacheer Kalvi board',
  'Voice-first lessons, auto-teach syllabus sentence-by-sentence, Tamil/Malayalam voice support, practice exams, Question Paper generator, Live Quiz Battle',
  'Warm, encouraging, parent-reassuring. Emphasize affordability and personal-tutor feel.',
  'Monthly ₹199 / Quarterly ₹567 / Annual ₹2148, 30-min free demo'
),
(
  'IND-Sugar Care',
  'Health management app for elderly Indian parents managing diabetes, with remote monitoring by adult children',
  'Adult children (often abroad or in another city) caring for elderly parents in India',
  'Voice-first input in 4 regional Indian languages, South Asian meal database, family caregiver dashboard, affordable pricing',
  'Caring, respectful of elders, reassuring for distant family members, simple language',
  'Affordable pricing, family plan focus'
),
(
  'AZHAR-AI',
  'Warehouse and logistics dashboard suite for operations teams',
  'Warehouse managers, logistics coordinators, business owners managing dispatch/inventory',
  'Dispatch dashboard, rejection tracking, automated proforma invoices, daily returns tracking, exec summary reports',
  'Professional, efficiency-focused, B2B tone',
  'Contact for pricing'
),
(
  'Binance Trading Bot',
  'Automated crypto trading bot for ETH/SOL/MATIC with per-user risk settings',
  'Crypto traders wanting automated, rule-based trading without watching charts all day',
  'Per-user trading engine, stop loss/take profit controls, custom risk settings, 24/7 automated execution',
  'Confident but careful — always mention crypto trading risk, never guarantee profits',
  '$30/month subscription'
)
ON CONFLICT (name) DO NOTHING;

-- =====================================================================
-- STAGE 1 ADDITIONS — roles, usage limits, compliance fields, new
-- prefixed tables. All additive and safe to run on your existing
-- database — nothing here drops or renames anything that exists.
-- This section runs AFTER the product seed above, so the compliance
-- UPDATE statements below correctly find and fill in the 4 products
-- whether this is a brand-new database or an existing one.
-- =====================================================================

-- Roles: every existing user defaults to 'admin' so your current login
-- keeps full access exactly as before. New users created later can be
-- given 'editor' or 'viewer'.
ALTER TABLE promo_users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'admin';

-- Compliance fields per product: banned claims and required disclaimer.
-- Left blank by default — fill in from the Products tab, or via the
-- seed UPDATE statements below for your 3 known products.
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS banned_claims TEXT;
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS required_disclaimer TEXT;
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS allowed_focus TEXT;
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS supported_languages TEXT;
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS free_trial_details TEXT;
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS main_cta TEXT;
ALTER TABLE promo_products ADD COLUMN IF NOT EXISTS website_link TEXT;

-- Fill in compliance data for your 3 known products — safe to run even if
-- these rows already exist or already have this data; it just re-sets the
-- same values. Only fires for products with these exact names.
UPDATE promo_products SET
  banned_claims = 'guaranteed marks, 100% result, CBSE approved (unless provided), government approved (unless provided), certified teacher (unless provided), no more study problems forever',
  allowed_focus = 'Local language learning, step-by-step explanation, parent support, homework help, free trial, affordable learning support',
  required_disclaimer = 'Results depend on student effort and usage.'
WHERE name = 'BrightMind Teacher';

UPDATE promo_products SET
  banned_claims = 'cures diabetes, reverses diabetes, guaranteed sugar control, doctor replacement, medical diagnosis, treatment promise',
  allowed_focus = 'Sugar tracking, medicine reminders, family alerts, doctor report, food log, lifestyle guidance',
  required_disclaimer = 'This app is for tracking and guidance only, not medical advice.'
WHERE name = 'IND-Sugar Care';

UPDATE promo_products SET
  banned_claims = 'guaranteed profit, no loss, risk-free trading, daily fixed income, financial advice promise',
  allowed_focus = 'Automation, risk controls, user-defined settings, tracking, clear risk warning',
  required_disclaimer = 'Crypto trading involves risk. No profit is guaranteed.'
WHERE name = 'Binance Trading Bot';

-- Usage tracking: one row per generation event, so daily/monthly limits
-- can be enforced and shown on an admin usage page.
CREATE TABLE IF NOT EXISTS promo_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES promo_users(id) ON DELETE SET NULL,
  usage_type VARCHAR(20) NOT NULL,     -- text | video
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_usage_type_date ON promo_usage(usage_type, created_at);

-- Admin-adjustable limits, stored as simple key/value settings.
CREATE TABLE IF NOT EXISTS promo_settings (
  key VARCHAR(50) PRIMARY KEY,
  value TEXT
);
INSERT INTO promo_settings (key, value) VALUES
  ('max_text_generations_per_day', '100'),
  ('max_video_generations_per_day', '20')
ON CONFLICT (key) DO NOTHING;
