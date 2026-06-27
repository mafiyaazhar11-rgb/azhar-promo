// AZHAR Promo — server.js
// Same stack pattern as your other apps: Node.js/Express, PostgreSQL, JWT.

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const textToSpeech = require('@google-cloud/text-to-speech');
require('dotenv').config();

ffmpeg.setFfmpegPath(ffmpegPath);

// Multer stores uploads temporarily on disk before processing.
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 25 * 1024 * 1024 } });

// Google Cloud TTS client. Auth comes from GOOGLE_APPLICATION_CREDENTIALS_JSON
// (the full service account JSON, pasted as a single env var on Render).
let ttsClient = null;
function getTtsClient() {
  if (ttsClient) return ttsClient;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set');
  }
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  ttsClient = new textToSpeech.TextToSpeechClient({ credentials });
  return ttsClient;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploy';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---------- Startup sanity checks ----------
// These don't crash the server — they just log clearly so a missing key
// shows up immediately in Render's logs instead of as a confusing 500
// later when someone actually tries to use that feature.
if (!process.env.DATABASE_URL) {
  console.error('WARNING: DATABASE_URL is not set. Database features will fail.');
}
if (!ANTHROPIC_API_KEY) {
  console.error('WARNING: ANTHROPIC_API_KEY is not set. Content generation will fail.');
}
if (!process.env.JWT_SECRET) {
  console.error('WARNING: JWT_SECRET is not set, using an insecure default. Set this in Render before real use.');
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  console.warn('NOTE: GOOGLE_APPLICATION_CREDENTIALS_JSON is not set. Video voiceover generation will fail until this is added.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Surface connection-level failures (e.g. DB temporarily unreachable)
// clearly in logs rather than letting them crash the process silently.
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

// ---------- Auth middleware ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'You are not logged in. Please log in again.' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

// Role-gating middleware — use after requireAuth. Admins pass everything;
// this only blocks roles below the one required.
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };
function requireRole(minRole) {
  return (req, res, next) => {
    const userRole = (req.user && req.user.role) || 'admin'; // existing tokens predate roles; treat as admin
    if ((ROLE_RANK[userRole] || 0) < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: `This action requires ${minRole} access.` });
    }
    next();
  };
}

// ---------- Usage limit enforcement ----------
async function checkUsageLimit(usageType) {
  const settingKey = usageType === 'video' ? 'max_video_generations_per_day' : 'max_text_generations_per_day';
  const settingResult = await pool.query('SELECT value FROM promo_settings WHERE key = $1', [settingKey]);
  const limit = settingResult.rows.length > 0 ? parseInt(settingResult.rows[0].value) : (usageType === 'video' ? 20 : 100);

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM promo_usage WHERE usage_type = $1 AND created_at >= CURRENT_DATE`,
    [usageType]
  );
  const usedToday = parseInt(countResult.rows[0].count);

  if (usedToday >= limit) {
    const error = new Error(`Daily limit reached: ${usedToday}/${limit} ${usageType} generations used today. This resets at midnight, or an admin can raise the limit in Settings.`);
    error.isLimitError = true;
    throw error;
  }
  return { usedToday, limit };
}

async function recordUsage(userId, usageType) {
  await pool.query('INSERT INTO promo_usage (user_id, usage_type) VALUES ($1, $2)', [userId, usageType]);
}

// ---------- Auth routes ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const result = await pool.query('SELECT * FROM promo_users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const role = user.role || 'admin';
    const token = jwt.sign({ id: user.id, username: user.username, role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, role });
  } catch (err) {
    console.error('Login error:', err);
    if (err.code === 'ECONNREFUSED' || err.code === '57P03') {
      return res.status(503).json({ error: 'Cannot reach the database right now. Please try again shortly.' });
    }
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Change password — requires being logged in already. No public account creation exists.
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const result = await pool.query('SELECT * FROM promo_users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE promo_users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error while changing password' });
  }
});

// ---------- Products routes ----------
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promo_products WHERE is_active = TRUE ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ error: 'Could not load products' });
  }
});

app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const { name, short_description, target_audience, key_features, tone_notes, pricing_info } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name is required' });
    const result = await pool.query(
      `INSERT INTO promo_products (name, short_description, target_audience, key_features, tone_notes, pricing_info)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, short_description, target_audience, key_features, tone_notes, pricing_info]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Could not create product' });
  }
});

app.put('/api/products/:id', requireAuth, async (req, res) => {
  try {
    const { name, short_description, target_audience, key_features, tone_notes, pricing_info } = req.body;
    const result = await pool.query(
      `UPDATE promo_products
       SET name = $1, short_description = $2, target_audience = $3, key_features = $4,
           tone_notes = $5, pricing_info = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [name, short_description, target_audience, key_features, tone_notes, pricing_info, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Could not update product' });
  }
});

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE promo_products SET is_active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ message: 'Product archived' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Could not archive product' });
  }
});

// ---------- AI generation route ----------
// Generates 5 content versions + hooks + hashtags + voiceover script + shot list,
// tailored by target audience, marketing angle, and output language.
app.post('/api/generate', requireAuth, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'Content generation is not configured yet — the Anthropic API key is missing on the server.' });
    }

    try {
      await checkUsageLimit('text');
    } catch (limitErr) {
      if (limitErr.isLimitError) return res.status(429).json({ error: limitErr.message });
      throw limitErr;
    }

    const {
      product_id, platform, content_type, extra_instructions,
      target_audience, marketing_angle, output_language
    } = req.body;

    if (!product_id || !platform || !content_type) {
      return res.status(400).json({ error: 'product_id, platform, and content_type are required' });
    }

    const productResult = await pool.query('SELECT * FROM promo_products WHERE id = $1', [product_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const product = productResult.rows[0];

    const platformStyleNotes = {
      facebook: 'Slightly longer, conversational, can include a question to encourage comments.',
      instagram: 'Short, punchy, emoji-friendly, strong hashtag set at the end.',
      tiktok: 'Hook in the first line, written like a script for a short video with energy and a clear call to action.',
      youtube: 'Written for YouTube — title should be search-friendly and clear, description can be a bit longer with keywords, good for both Shorts and regular video framing.'
    };

    const contentTypeNotes = {
      new_feature: 'Highlight a specific feature and why it matters to the user.',
      testimonial: 'Write as if quoting a happy customer (clearly marked as an example, not a real quote unless one is provided).',
      pricing_offer: 'Lead with the value, mention price clearly, include urgency without being pushy.',
      daily_tip: 'Give a genuinely useful tip related to the product\'s subject area, with a soft mention of the product.',
      whatsapp_group: 'Written for sharing directly into a parent WhatsApp group — friendly, informal, easy to forward, not overly salesy, can include 1-2 emojis.',
      poster_text: 'Written for a printable/shareable poster image — needs a short punchy headline, one supporting subheadline, and one clear call-to-action line. Keep each part very short.',
      youtube_shorts: 'Written for a YouTube Short — needs a strong hook in the first 2 seconds, a punchy on-screen title (under 60 characters), and a short description with relevant keywords for YouTube search. The voiceover script and shot list should follow the same 0-30 sec format as other short-form video.'
    };

    const audienceNotes = {
      parents: 'Speak to parents worried about their child\'s education and future.',
      students: 'Speak directly to the student, energetic and relatable.',
      tuition_teachers: 'Speak to tuition/private teachers about how this complements or supports their teaching.',
      school_groups: 'Speak to school administrators or teacher groups about adopting this for their students.',
      exam_prep_students: 'Speak to students specifically preparing for upcoming board or competitive exams, focus on exam readiness.'
    };

    const angleNotes = {
      tuition_cost: 'Lead with how expensive private tuition is, and position this as a far more affordable alternative.',
      language_problem: 'Lead with the problem of students struggling because lessons aren\'t taught in their home language.',
      exam_fear: 'Lead with the anxiety and fear around board exams, and how this app builds confidence.',
      homework_help: 'Lead with the daily struggle of homework time at home and how this app makes it easier.',
      parent_peace_of_mind: 'Lead with how this gives parents peace of mind about their child\'s learning, even if the parent can\'t personally teach the subject.',
      free_trial: 'Lead with the free trial offer as the main hook, low-risk way to try it.',
      tuition_comparison: 'Directly compare this app against traditional tuition centers — cost, flexibility, language, convenience.'
    };

    const languageNotes = {
      english: 'Write entirely in English.',
      tamil: 'Write entirely in Tamil (Tamil script).',
      malayalam: 'Write entirely in Malayalam (Malayalam script).',
      hindi: 'Write entirely in Hindi (Devanagari script).',
      tamil_english_mix: 'Write in a natural Tamil-English mix (Tanglish), the way young Tamil parents actually text and post on social media.',
      malayalam_english_mix: 'Write in a natural Malayalam-English mix (Manglish), the way young Malayalam parents actually text and post on social media.'
    };

    const complianceRule = product.banned_claims || product.required_disclaimer
      ? `
COMPLIANCE RULE FOR THIS PRODUCT — follow this strictly, no exceptions:
${product.banned_claims ? `Do NOT generate or imply any of these claims: ${product.banned_claims}. If a claim like this is not explicitly supported by the product details given, do not invent it, hint at it, or imply it, even loosely.` : ''}
${product.allowed_focus ? `Instead, focus only on real, honest value such as: ${product.allowed_focus}.` : ''}
${product.required_disclaimer ? `Where natural, the content should be consistent with this disclaimer (you do not need to print it verbatim in every version, but never contradict it): "${product.required_disclaimer}"` : ''}`
      : `
COMPLIANCE RULE — follow this strictly, no exceptions:
Do NOT generate claims of guaranteed marks, guaranteed results, "100% result", "CBSE approved",
"government certified", "certified teachers", or any similar certification/approval/guarantee claim,
UNLESS that exact fact was explicitly provided to you in the product's details below. Focus on real,
honest value: convenience, affordability, language support, practice opportunities, parent involvement
— never fabricated outcomes or certifications.`;

    const systemPrompt = `You are a marketing copywriter helping a solo developer in the UAE promote his Indian education app. Always respond ONLY in valid JSON, no preamble, no markdown fences. The JSON must have this exact shape:
{
  "versions": {
    "emotional": "an emotional, story-driven version of the post",
    "direct_sales": "a direct, benefit-and-price-focused sales version",
    "reel_caption": "a short punchy caption written for a Reel/TikTok video, with emojis",
    "whatsapp_message": "a friendly, forwardable message written for a parent WhatsApp group",
    "ad_copy": "a version written like a paid ad — clear hook, benefit, and call to action"
  },
  "hooks": ["hook 1", "hook 2", "hook 3", "hook 4", "hook 5"],
  "hashtags": "#tag1 #tag2 #tag3",
  "voiceover_script": "a short script, 30-45 seconds when spoken aloud, written in plain spoken sentences",
  "shot_list": [
    "0-3 sec (Hook): ...",
    "3-8 sec (Problem): ...",
    "8-15 sec (App demo): ...",
    "15-22 sec (Benefit): ...",
    "22-30 sec (CTA): ..."
  ]
}
The "hooks" array must contain 5 distinct, strong first-line hooks suitable for opening a reel or ad about this exact product, angle, and audience — these are alternatives to choose from, not part of any one version.
${complianceRule}`;

    const userPrompt = `Product: ${product.name}
Description: ${product.short_description}
Target audience (product-level): ${product.target_audience}
Key features: ${product.key_features}
Tone notes: ${product.tone_notes}
Pricing info: ${product.pricing_info}

Platform: ${platform} (${platformStyleNotes[platform] || ''})
Content type: ${content_type} (${contentTypeNotes[content_type] || ''})
${target_audience ? 'Specific audience for this post: ' + target_audience + ' — ' + (audienceNotes[target_audience] || '') : ''}
${marketing_angle ? 'Marketing angle: ' + marketing_angle + ' — ' + (angleNotes[marketing_angle] || '') : ''}
${output_language ? 'Output language: ' + (languageNotes[output_language] || output_language) : 'Output language: English'}
${extra_instructions ? 'Extra instructions from the user: ' + extra_instructions : ''}

Generate all 5 content versions (emotional, direct_sales, reel_caption, whatsapp_message, ad_copy), 5 hook lines, a hashtag set, a voiceover script meant to be read aloud over real screen-recording footage of the actual app (do not describe a fake UI — keep it generic enough that it works over any real screen recording of this product), and a shot list using the exact 5-beat timed format shown in the JSON shape (Hook / Problem / App demo / Benefit / CTA) describing what to record at each beat.`;

    let aiResponse;
    try {
      aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2500,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
    } catch (networkErr) {
      console.error('Anthropic API network error:', networkErr);
      return res.status(502).json({ error: 'Could not reach the AI service. Please check your connection and try again.' });
    }

    if (!aiResponse.ok) {
      const errText = await aiResponse.text().catch(() => '');
      console.error('Anthropic API error:', aiResponse.status, errText);
      if (aiResponse.status === 401) {
        return res.status(503).json({ error: 'The Anthropic API key is invalid or missing. Check Render environment variables.' });
      }
      if (aiResponse.status === 429) {
        return res.status(429).json({ error: 'The AI service is rate-limited right now. Please wait a moment and try again.' });
      }
      return res.status(502).json({ error: 'The AI service returned an error. Please try again.' });
    }

    const aiData = await aiResponse.json();
    if (!aiData.content || !aiData.content[0] || !aiData.content[0].text) {
      console.error('Unexpected AI response shape:', JSON.stringify(aiData));
      return res.status(502).json({ error: 'AI generation failed, please try again' });
    }

    let parsed = tryParseAiJson(aiData.content[0].text);

    if (!parsed) {
      // One automatic retry with a stricter, English-language reminder appended —
      // this is the most reliable fix for cases where writing in a non-English
      // script (Tamil/Malayalam/Hindi) caused a stray quote or line break to
      // slip into the JSON structure.
      console.warn('First JSON parse failed, retrying once with a stricter prompt...');
      const retryResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2500,
          system: systemPrompt + '\n\nCRITICAL: Your entire reply must be ONE valid JSON object and nothing else. Inside any string value, never use double-quote characters (") — if you need to quote something, rephrase without quotes. Never include literal line breaks inside a string value; use a space instead.',
          messages: [{ role: 'user', content: userPrompt }]
        })
      }).catch(() => null);

      if (retryResponse && retryResponse.ok) {
        const retryData = await retryResponse.json();
        if (retryData.content && retryData.content[0] && retryData.content[0].text) {
          parsed = tryParseAiJson(retryData.content[0].text);
        }
      }
    }

    if (!parsed) {
      return res.status(502).json({ error: 'AI returned an unexpected format, please try again — this can happen more often with non-English languages, a second attempt usually works.' });
    }

    await recordUsage(req.user.id, 'text');
    res.json(parsed);
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Server error during generation' });
  }
});

// ---------- Posts routes (save / library) ----------
app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const { product_id, platform, status, target_audience, search } = req.query;
    let query = `
      SELECT p.*, pr.name AS product_name
      FROM promo_posts p
      JOIN promo_products pr ON p.product_id = pr.id
      WHERE 1=1
    `;
    const params = [];
    if (product_id) {
      params.push(product_id);
      query += ` AND p.product_id = $${params.length}`;
    }
    if (platform) {
      params.push(platform);
      query += ` AND p.platform = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND p.status = $${params.length}`;
    }
    if (target_audience) {
      params.push(target_audience);
      query += ` AND p.target_audience = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.caption ILIKE $${params.length} OR p.hashtags ILIKE $${params.length} OR p.voiceover_script ILIKE $${params.length})`;
    }
    query += ' ORDER BY p.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get posts error:', err);
    res.status(500).json({ error: 'Could not load posts' });
  }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const {
      product_id, platform, content_type, caption, hashtags, voiceover_script, shot_list,
      target_audience, marketing_angle, output_language, hooks, versions
    } = req.body;
    const result = await pool.query(
      `INSERT INTO promo_posts
         (product_id, platform, content_type, caption, hashtags, voiceover_script, shot_list,
          target_audience, marketing_angle, output_language, hooks, versions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        product_id, platform, content_type, caption, hashtags, voiceover_script,
        Array.isArray(shot_list) ? shot_list.join('\n') : shot_list,
        target_audience || null, marketing_angle || null, output_language || null,
        Array.isArray(hooks) ? hooks.join('\n') : (hooks || null),
        versions ? JSON.stringify(versions) : null
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Save post error:', err);
    res.status(500).json({ error: 'Could not save post' });
  }
});

app.put('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const { status, performance_notes } = req.body;
    const fields = [];
    const params = [];
    let i = 1;

    if (status !== undefined) {
      fields.push(`status = $${i++}`);
      params.push(status);
      if (status === 'posted') {
        fields.push(`posted_at = NOW()`);
      }
    }
    if (performance_notes !== undefined) {
      fields.push(`performance_notes = $${i++}`);
      params.push(performance_notes);
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE promo_posts SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update post error:', err);
    res.status(500).json({ error: 'Could not update post' });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM promo_posts WHERE id = $1', [req.params.id]);
    res.json({ message: 'Post deleted' });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: 'Could not delete post' });
  }
});

// ---------- Content calendar routes ----------
app.get('/api/calendar', requireAuth, async (req, res) => {
  try {
    const { product_id, week_start_date } = req.query;
    if (!product_id || !week_start_date) {
      return res.status(400).json({ error: 'product_id and week_start_date are required' });
    }
    const result = await pool.query(
      `SELECT * FROM promo_calendar WHERE product_id = $1 AND week_start_date = $2 ORDER BY id ASC`,
      [product_id, week_start_date]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get calendar error:', err);
    res.status(500).json({ error: 'Could not load calendar' });
  }
});

app.post('/api/calendar/generate', requireAuth, async (req, res) => {
  try {
    const { product_id, week_start_date } = req.body;
    if (!product_id || !week_start_date) {
      return res.status(400).json({ error: 'product_id and week_start_date are required' });
    }
    const productResult = await pool.query('SELECT * FROM promo_products WHERE id = $1', [product_id]);
    if (productResult.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const product = productResult.rows[0];

    const systemPrompt = `You are a marketing planner for an Indian education app. Always respond ONLY in valid JSON, no preamble, no markdown fences. The JSON must be an array of exactly 7 objects, one per day Monday through Sunday, in this shape:
[
  { "day_of_week": "Monday", "content_idea": "...", "platform": "instagram", "caption_idea": "...", "cta": "..." },
  ... (Tuesday through Sunday)
]
"platform" must be one of: instagram, facebook, tiktok, whatsapp.
Vary the content ideas and platforms across the week — do not repeat the same idea or angle every day.
${`COMPLIANCE RULE: Do not invent guaranteed results, "100% result", "CBSE approved", or certified-teacher claims unless explicitly given in the product details below.`}`;

    const userPrompt = `Product: ${product.name}
Description: ${product.short_description}
Target audience: ${product.target_audience}
Key features: ${product.key_features}
Tone notes: ${product.tone_notes}
Pricing info: ${product.pricing_info}

Generate a full Monday-to-Sunday content posting plan for this week.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const aiData = await aiResponse.json();
    if (!aiData.content || !aiData.content[0] || !aiData.content[0].text) {
      return res.status(502).json({ error: 'AI generation failed, please try again' });
    }
    const days = tryParseAiJson(aiData.content[0].text);
    if (!days) {
      return res.status(502).json({ error: 'AI returned an unexpected format, please try again' });
    }

    // Replace any existing plan for this product/week, then insert the fresh one
    await pool.query('DELETE FROM promo_calendar WHERE product_id = $1 AND week_start_date = $2', [product_id, week_start_date]);

    const inserted = [];
    for (const day of days) {
      const result = await pool.query(
        `INSERT INTO promo_calendar (product_id, week_start_date, day_of_week, content_idea, platform, caption_idea, cta)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [product_id, week_start_date, day.day_of_week, day.content_idea, day.platform, day.caption_idea, day.cta]
      );
      inserted.push(result.rows[0]);
    }
    res.json(inserted);
  } catch (err) {
    console.error('Generate calendar error:', err);
    res.status(500).json({ error: 'Could not generate calendar' });
  }
});

app.put('/api/calendar/:id', requireAuth, async (req, res) => {
  try {
    const { content_idea, platform, caption_idea, cta } = req.body;
    const result = await pool.query(
      `UPDATE promo_calendar SET content_idea = $1, platform = $2, caption_idea = $3, cta = $4 WHERE id = $5 RETURNING *`,
      [content_idea, platform, caption_idea, cta, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Calendar entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update calendar error:', err);
    res.status(500).json({ error: 'Could not update calendar entry' });
  }
});

// ---------- Video generation ----------
// Takes: screenshots (already cropped client-side), a voiceover script, and an
// optional music file. Produces a downloadable 1080x1920 MP4 with voiceover,
// burned-in subtitles, and mild background music.
app.post('/api/video/generate',
  requireAuth,
  upload.fields([{ name: 'screenshots', maxCount: 12 }, { name: 'music', maxCount: 1 }]),
  async (req, res) => {
    const tempFiles = []; // track everything to clean up at the end
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workDir = path.join(os.tmpdir(), jobId);

    try {
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        return res.status(503).json({ error: 'Video generation is not configured yet — the Google Cloud credentials are missing on the server.' });
      }

      try {
        await checkUsageLimit('video');
      } catch (limitErr) {
        if (limitErr.isLimitError) return res.status(429).json({ error: limitErr.message });
        throw limitErr;
      }

      const { voiceover_script, voice_language, voice_gender } = req.body;
      const screenshots = req.files['screenshots'] || [];
      const musicFile = req.files['music'] ? req.files['music'][0] : null;
      const ssmlGender = (voice_gender === 'MALE') ? 'MALE' : 'FEMALE'; // default to FEMALE if not specified

      if (!voiceover_script || screenshots.length === 0) {
        return res.status(400).json({ error: 'A voiceover script and at least one screenshot are required' });
      }

      fs.mkdirSync(workDir, { recursive: true });

      // 1. Generate voiceover audio via Google Cloud TTS — using SSML <mark>
      //    tags before each sentence so Google returns the EXACT time each
      //    sentence starts being spoken. This gives real, measured subtitle
      //    timing instead of an evenly-divided estimate.
      const sentences = splitIntoSentences(voiceover_script);
      const ssml = buildMarkedSsml(sentences);

      let ttsResponse;
      try {
        const client = getTtsClient();
        const languageCode = voice_language || 'en-IN';
        [ttsResponse] = await client.synthesizeSpeech({
          input: { ssml },
          voice: { languageCode, ssmlGender },
          audioConfig: { audioEncoding: 'MP3' },
          enableTimePointing: ['SSML_MARK']
        });
      } catch (ttsErr) {
        console.error('Google TTS error (with SSML marks):', ttsErr);
        // Fallback: some languages/voices don't support SSML marks reliably.
        // Retry with plain text so voiceover generation still succeeds —
        // subtitles will fall back to the even-split estimate in this case.
        try {
          const client = getTtsClient();
          const languageCode = voice_language || 'en-IN';
          [ttsResponse] = await client.synthesizeSpeech({
            input: { text: voiceover_script },
            voice: { languageCode, ssmlGender },
            audioConfig: { audioEncoding: 'MP3' }
          });
        } catch (fallbackErr) {
          console.error('Google TTS fallback error:', fallbackErr);
          throw new Error('Voiceover generation failed. Check the Google Cloud credentials and that the Text-to-Speech API is enabled.');
        }
      }
      const voicePath = path.join(workDir, 'voice.mp3');
      fs.writeFileSync(voicePath, ttsResponse.audioContent, 'binary');
      tempFiles.push(voicePath);

      // 2. Get the voiceover's actual duration so we can time screenshots evenly
      const voiceDuration = await getAudioDuration(voicePath);
      const perImageDuration = Math.max(voiceDuration / screenshots.length, 1.5);

      // 3. Build the subtitle file (.srt). If Google returned real timepoints
      //    for our sentence marks, use those exact times — otherwise fall
      //    back to the even-split estimate.
      const srtPath = path.join(workDir, 'subs.srt');
      if (ttsResponse.timepoints && ttsResponse.timepoints.length > 0) {
        writeSrtFileFromTimepoints(srtPath, sentences, ttsResponse.timepoints, voiceDuration);
      } else {
        writeSrtFile(srtPath, voiceover_script, voiceDuration);
      }
      tempFiles.push(srtPath);

      // 4. Build the FFmpeg input list (each screenshot shown for perImageDuration)
      const concatListPath = path.join(workDir, 'concat.txt');
      let concatContent = '';
      screenshots.forEach(file => {
        concatContent += `file '${file.path.replace(/'/g, "'\\''")}'\nduration ${perImageDuration}\n`;
      });
      // FFmpeg's concat demuxer needs the last file repeated without a duration line
      concatContent += `file '${screenshots[screenshots.length - 1].path.replace(/'/g, "'\\''")}'\n`;
      fs.writeFileSync(concatListPath, concatContent);
      tempFiles.push(concatListPath);

      const silentVideoPath = path.join(workDir, 'silent.mp4');
      const finalVideoPath = path.join(workDir, 'final.mp4');
      tempFiles.push(silentVideoPath, finalVideoPath);

      // 5. Assemble screenshots into a silent vertical video with burned-in subtitles
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .videoFilters([
            "scale=1080:1920:force_original_aspect_ratio=decrease",
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black",
            `subtitles='${srtPath.replace(/:/g, '\\:')}':force_style='FontSize=20,PrimaryColour=&HFFFFFF&,BorderStyle=3,Outline=1,Alignment=2,MarginV=80'`
          ])
          .outputOptions(['-r', '30', '-pix_fmt', 'yuv420p'])
          .output(silentVideoPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // 6. Mix voiceover (+ optional quiet background music) onto the video
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(silentVideoPath).input(voicePath);

        if (musicFile) {
          cmd.input(musicFile.path);
          tempFiles.push(musicFile.path);
          cmd.complexFilter([
            // Loop music quietly under the voice; voice stays at full volume
            '[2:a]volume=0.15,aloop=loop=-1:size=2e9[music]',
            '[1:a][music]amix=inputs=2:duration=first:dropout_transition=2[audioOut]'
          ]);
          cmd.outputOptions(['-map', '0:v', '-map', '[audioOut]', '-shortest', '-c:v', 'copy', '-c:a', 'aac']);
        } else {
          cmd.outputOptions(['-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'copy', '-c:a', 'aac']);
        }

        cmd.output(finalVideoPath).on('end', resolve).on('error', reject).run();
      });

      // 7. Record usage, send the finished file, then clean up
      await recordUsage(req.user.id, 'video');
      res.download(finalVideoPath, 'azhar-promo-video.mp4', () => {
        cleanupFiles(tempFiles);
        fs.rm(workDir, { recursive: true, force: true }, () => {});
        screenshots.forEach(f => fs.unlink(f.path, () => {}));
      });

    } catch (err) {
      console.error('Video generation error:', err);
      cleanupFiles(tempFiles);
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      if (req.files) {
        const allFiles = [...(req.files['screenshots'] || []), ...(req.files['music'] || [])];
        allFiles.forEach(f => fs.unlink(f.path, () => {}));
      }
      res.status(500).json({ error: err.message || 'Video generation failed. Please try again.' });
    }
  }
);

// Robustly extracts and parses a JSON object OR array from an AI response,
// even if the model wrapped it in markdown fences or added stray text
// before/after. Returns null (never throws) if nothing could be recovered.
function tryParseAiJson(rawText) {
  if (!rawText) return null;

  // Attempt 1: strip markdown fences, parse as-is.
  let cleanText = rawText.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleanText);
  } catch (e) { /* fall through */ }

  // Attempt 2: extract just the outermost JSON block — object {...} or
  // array [...], whichever appears first — in case the model added an
  // explanation before or after the JSON despite instructions.
  const firstObj = cleanText.indexOf('{');
  const firstArr = cleanText.indexOf('[');
  let openChar, closeChar, firstIdx;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    openChar = '['; closeChar = ']'; firstIdx = firstArr;
  } else {
    openChar = '{'; closeChar = '}'; firstIdx = firstObj;
  }

  if (firstIdx !== -1) {
    const lastIdx = cleanText.lastIndexOf(closeChar);
    if (lastIdx > firstIdx) {
      const extracted = cleanText.slice(firstIdx, lastIdx + 1);
      try {
        return JSON.parse(extracted);
      } catch (e) { /* fall through */ }

      // Attempt 3: replace literal newlines/tabs inside the extracted block —
      // a common cause of breakage when non-English scripts slip in raw
      // line breaks instead of escaped \n.
      try {
        const fixed = extracted.replace(/[\r\n\t]+/g, ' ');
        return JSON.parse(fixed);
      } catch (e) { /* fall through */ }
    }
  }

  console.error('Could not parse AI response as JSON after all attempts:', rawText.slice(0, 2000));
  return null;
}

function cleanupFiles(paths) {
  paths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 30);
    });
  });
}

// Splits the script into readable chunks and writes a basic, evenly-timed .srt file.
function writeSrtFile(srtPath, script, totalDuration) {
  const sentences = script
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);

  if (sentences.length === 0) sentences.push(script);

  const perSentence = totalDuration / sentences.length;
  let srt = '';
  let t = 0;
  sentences.forEach((sentence, i) => {
    const start = formatSrtTime(t);
    const end = formatSrtTime(t + perSentence);
    srt += `${i + 1}\n${start} --> ${end}\n${sentence.trim()}\n\n`;
    t += perSentence;
  });
  fs.writeFileSync(srtPath, srt);
}

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Shared sentence splitter — same logic writeSrtFile already used, pulled
// out so the SSML-marking path and the fallback path stay consistent.
function splitIntoSentences(script) {
  const sentences = script
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);
  return sentences.length > 0 ? sentences : [script];
}

// Escapes the handful of characters SSML/XML treats specially, so sentence
// text can't accidentally break the markup we're wrapping it in.
function escapeSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Builds an SSML document with a named <mark> immediately before each
// sentence. Combined with enableTimePointing: ['SSML_MARK'] on the TTS
// request, Google returns the exact second each mark was reached in the
// generated audio — i.e. exactly when each sentence starts being spoken.
function buildMarkedSsml(sentences) {
  const body = sentences
    .map((sentence, i) => `<mark name="s${i}"/>${escapeSsml(sentence.trim())}`)
    .join(' ');
  return `<speak>${body}</speak>`;
}

// Writes subtitles using REAL measured timepoints from Google TTS rather
// than an even split — each sentence's subtitle now starts exactly when
// that sentence actually begins in the audio.
function writeSrtFileFromTimepoints(srtPath, sentences, timepoints, totalDuration) {
  // timepoints come back as [{ markName: 's0', timeSeconds: 0.42 }, ...] —
  // map mark name -> time, then look each sentence's start time up by index.
  const timeByMark = {};
  timepoints.forEach(tp => { timeByMark[tp.markName] = tp.timeSeconds; });

  let srt = '';
  sentences.forEach((sentence, i) => {
    const start = timeByMark[`s${i}`] !== undefined ? timeByMark[`s${i}`] : null;
    if (start === null) return; // skip if Google didn't return this mark for some reason

    const nextStart = timeByMark[`s${i + 1}`] !== undefined ? timeByMark[`s${i + 1}`] : totalDuration;
    const end = Math.max(nextStart, start + 0.5); // guard against zero/negative duration

    srt += `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${sentence.trim()}\n\n`;
  });

  // If for some reason nothing got written (e.g. all marks missing),
  // fall back to the even-split version so subtitles still appear.
  if (!srt.trim()) {
    writeSrtFile(srtPath, sentences.join(' '), totalDuration);
    return;
  }

  fs.writeFileSync(srtPath, srt);
}


// Runs schema.sql (tables + migrations). Safe to visit repeatedly at any
// time — every statement in schema.sql uses IF NOT EXISTS / ON CONFLICT,
// so re-running it only adds new tables/columns, never duplicates or
// destroys existing data. Does NOT create any login — see /api/setup-db below.
app.get('/api/migrate-db', async (req, res) => {
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schemaSql);
    res.send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;">
        <h2>Migration complete ✅</h2>
        <p>Tables and columns are up to date. Your existing data was not touched.</p>
        <a href="/" style="color:#1f6f6b;font-weight:600;">Go to AZHAR Promo</a>
      </div>
    `);
  } catch (err) {
    console.error('Migrate-db error:', err);
    res.status(500).send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;">
        <h2>Migration failed</h2>
        <pre style="white-space:pre-wrap;background:#fbe9e2;padding:12px;border-radius:8px;">${err.message || err}</pre>
      </div>
    `);
  }
});

// One-time setup: visit this URL once in your browser to create the database
// tables AND the single login (username: azhar / password: azhar2026).
//
// PERMANENTLY LOCKED after the first user is created — this checks
// promo_users every time and refuses outright if anyone already exists,
// with no way to re-trigger it short of deleting the user from the
// database directly. This is intentional: it is the one thing in this
// app that must never be runnable twice.
app.get('/api/setup-db', async (req, res) => {
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schemaSql);

    const existing = await pool.query('SELECT COUNT(*) FROM promo_users');
    if (parseInt(existing.rows[0].count) > 0) {
      return res.status(403).send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;">
          <h2>Setup already completed 🔒</h2>
          <p>A login already exists, so this route is permanently locked. If you've
          forgotten the password, use the Settings tab once logged in, or contact
          whoever manages this database directly.</p>
          <a href="/" style="color:#1f6f6b;font-weight:600;">Go to AZHAR Promo</a>
        </div>
      `);
    }

    const hash = await bcrypt.hash('azhar2026', 10);
    await pool.query("INSERT INTO promo_users (username, password_hash, role) VALUES ($1, $2, 'admin')", ['azhar', hash]);

    res.send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;">
        <h2>Setup complete ✅</h2>
        <p>Tables created, products seeded, and your login is ready.</p>
        <p><b>Username:</b> azhar<br><b>Password:</b> azhar2026</p>
        <p>You can change this password anytime from inside the app once logged in.</p>
        <p style="color:#a8401f;font-size:13px;">This setup page is now permanently locked and cannot be used again.</p>
        <a href="/" style="color:#1f6f6b;font-weight:600;">Go to AZHAR Promo</a>
      </div>
    `);
  } catch (err) {
    console.error('Setup-db error:', err);
    res.status(500).send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;">
        <h2>Setup failed</h2>
        <pre style="white-space:pre-wrap;background:#fbe9e2;padding:12px;border-radius:8px;">${err.message || err}</pre>
      </div>
    `);
  }
});

// ---------- Usage / cost dashboard (admin only) ----------
app.get('/api/usage', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const textToday = await pool.query(`SELECT COUNT(*) FROM promo_usage WHERE usage_type = 'text' AND created_at >= CURRENT_DATE`);
    const videoToday = await pool.query(`SELECT COUNT(*) FROM promo_usage WHERE usage_type = 'video' AND created_at >= CURRENT_DATE`);
    const textMonth = await pool.query(`SELECT COUNT(*) FROM promo_usage WHERE usage_type = 'text' AND created_at >= date_trunc('month', CURRENT_DATE)`);
    const videoMonth = await pool.query(`SELECT COUNT(*) FROM promo_usage WHERE usage_type = 'video' AND created_at >= date_trunc('month', CURRENT_DATE)`);
    const settings = await pool.query('SELECT key, value FROM promo_settings');
    const settingsMap = {};
    settings.rows.forEach(s => { settingsMap[s.key] = s.value; });

    res.json({
      text_generations_today: parseInt(textToday.rows[0].count),
      video_generations_today: parseInt(videoToday.rows[0].count),
      text_generations_this_month: parseInt(textMonth.rows[0].count),
      video_generations_this_month: parseInt(videoMonth.rows[0].count),
      max_text_generations_per_day: parseInt(settingsMap.max_text_generations_per_day || 100),
      max_video_generations_per_day: parseInt(settingsMap.max_video_generations_per_day || 20)
    });
  } catch (err) {
    console.error('Get usage error:', err);
    res.status(500).json({ error: 'Could not load usage data' });
  }
});

app.put('/api/usage/limits', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { max_text_generations_per_day, max_video_generations_per_day } = req.body;
    if (max_text_generations_per_day !== undefined) {
      await pool.query(
        `INSERT INTO promo_settings (key, value) VALUES ('max_text_generations_per_day', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(max_text_generations_per_day)]
      );
    }
    if (max_video_generations_per_day !== undefined) {
      await pool.query(
        `INSERT INTO promo_settings (key, value) VALUES ('max_video_generations_per_day', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(max_video_generations_per_day)]
      );
    }
    res.json({ message: 'Limits updated' });
  } catch (err) {
    console.error('Update limits error:', err);
    res.status(500).json({ error: 'Could not update limits' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`AZHAR Promo server running on port ${PORT}`);
});
