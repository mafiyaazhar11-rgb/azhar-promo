// AZHAR Promo — server.js
// Same stack pattern as your other apps: Node.js/Express, PostgreSQL, JWT.

const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploy';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- Auth middleware ----------
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------- Auth routes ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM promo_users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// One-time setup route to create the shared login. Disable or remove after first use.
app.post('/api/auth/setup', async (req, res) => {
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM promo_users');
    if (parseInt(existing.rows[0].count) > 0) {
      return res.status(403).json({ error: 'Setup already completed. A user already exists.' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO promo_users (username, password_hash) VALUES ($1, $2)', [username, hash]);
    res.json({ message: 'Setup complete. You can now log in.' });
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({ error: 'Server error during setup' });
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
app.post('/api/generate', requireAuth, async (req, res) => {
  try {
    const { product_id, platform, content_type, extra_instructions } = req.body;
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
      tiktok: 'Hook in the first line, written like a script for a short video with energy and a clear call to action.'
    };

    const contentTypeNotes = {
      new_feature: 'Highlight a specific feature and why it matters to the user.',
      testimonial: 'Write as if quoting a happy customer (clearly marked as an example, not a real quote unless one is provided).',
      pricing_offer: 'Lead with the value, mention price clearly, include urgency without being pushy.',
      daily_tip: 'Give a genuinely useful tip related to the product\'s subject area, with a soft mention of the product.'
    };

    const systemPrompt = `You are a marketing copywriter helping a solo developer in the UAE promote his own apps on social media. Always respond ONLY in valid JSON, no preamble, no markdown fences. The JSON must have this exact shape:
{
  "captions": ["option 1", "option 2", "option 3"],
  "hashtags": "#tag1 #tag2 #tag3",
  "voiceover_script": "a short script, 30-45 seconds when spoken aloud, written in plain spoken sentences",
  "shot_list": ["Shot 1: ...", "Shot 2: ...", "Shot 3: ..."]
}`;

    const userPrompt = `Product: ${product.name}
Description: ${product.short_description}
Target audience: ${product.target_audience}
Key features: ${product.key_features}
Tone notes: ${product.tone_notes}
Pricing info: ${product.pricing_info}

Platform: ${platform} (${platformStyleNotes[platform] || ''})
Content type: ${content_type} (${contentTypeNotes[content_type] || ''})
${extra_instructions ? 'Extra instructions from the user: ' + extra_instructions : ''}

Generate 3 caption options, a hashtag set, a voiceover script meant to be read aloud over real screen-recording footage of the actual app (do not describe a fake UI — keep it generic enough that it works over any real screen recording of this product), and a shot list describing what to record (in plain terms like "record the login screen" or "record the voice input feature being used") to match the script.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const aiData = await aiResponse.json();
    if (!aiData.content || !aiData.content[0] || !aiData.content[0].text) {
      console.error('Unexpected AI response shape:', JSON.stringify(aiData));
      return res.status(502).json({ error: 'AI generation failed, please try again' });
    }

    let parsed;
    try {
      const cleanText = aiData.content[0].text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleanText);
    } catch (parseErr) {
      console.error('Failed to parse AI response as JSON:', aiData.content[0].text);
      return res.status(502).json({ error: 'AI returned an unexpected format, please try again' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Server error during generation' });
  }
});

// ---------- Posts routes (save / library) ----------
app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const { product_id, platform, status } = req.query;
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
    const { product_id, platform, content_type, caption, hashtags, voiceover_script, shot_list } = req.body;
    const result = await pool.query(
      `INSERT INTO promo_posts (product_id, platform, content_type, caption, hashtags, voiceover_script, shot_list)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [product_id, platform, content_type, caption, hashtags, voiceover_script,
       Array.isArray(shot_list) ? shot_list.join('\n') : shot_list]
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

// One-time setup: visit this URL once in your browser to create the database tables.
// Safe to visit more than once (uses CREATE TABLE IF NOT EXISTS).
app.get('/api/setup-db', async (req, res) => {
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schemaSql);
    res.send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;">
        <h2>Database setup complete ✅</h2>
        <p>Tables created and your 4 products are seeded. You can go back and create the shared login now.</p>
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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`AZHAR Promo server running on port ${PORT}`);
});
