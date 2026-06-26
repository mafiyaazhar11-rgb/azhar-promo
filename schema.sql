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
  content_type VARCHAR(50) NOT NULL,   -- new_feature | testimonial | pricing_offer | daily_tip | etc.
  caption TEXT,
  hashtags TEXT,
  voiceover_script TEXT,
  shot_list TEXT,
  status VARCHAR(20) DEFAULT 'draft',  -- draft | posted
  performance_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  posted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_promo_posts_product ON promo_posts(product_id);
CREATE INDEX IF NOT EXISTS idx_promo_posts_status ON promo_posts(status);

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
ON CONFLICT DO NOTHING;
