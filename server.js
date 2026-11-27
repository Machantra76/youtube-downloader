require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('❌ Missing DATABASE_URL environment variable.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(
  session({
    name: 'laundry.sid',
    secret: process.env.SESSION_SECRET || 'laundry-secret-key-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

const publicDir = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(publicDir));

const STANDARD_CATEGORIES = [
  'អាវយឺត (T-Shirt)',
  'អាវសាច់ក្រណាត់ (Shirt)',
  'អាវធំ / អាវក្រៅ (Jacket)',
  'អាវសាច់ក្រណាត់ / អាវធំ (Shirt & Jacket)',
  'ខោជើងវែង (Long Pants)',
  'ខោខូវប៊យ (Jeans)',
  'ខោខ្លី (Shorts)',
  'កម្រាលពូក (Bed Sheet)',
  'ភួយ / ផួយក្រាស់ (Blanket)',
  'កម្រាលពូក / ភួយ (Bed Sheet & Blanket)',
  'សំពត់ / ឈុត (Skirt & Suit)',
  'ទំនិញផ្សេងៗ (Other Item)',
  'ផ្សេងៗ (Others)'
];

const ALLOWED_STATUSES = ['Pending', 'Washing', 'Ready', 'Picked Up'];

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, error: 'សូម Login ជាមុនសិន' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, error: 'សូម Login ជាមុនសិន' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'មានតែ Admin ប៉ុណ្ណោះដែលមានសិទ្ធិ' });
  }
  next();
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(60) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'staff',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS laundry_orders (
      id SERIAL PRIMARY KEY,
      order_code VARCHAR(30) UNIQUE NOT NULL,
      customer_name VARCHAR(120) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'អាវយឺត (T-Shirt)',
      service_type VARCHAR(80) NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 1,
      weight_kg NUMERIC(10, 2) NOT NULL DEFAULT 1,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      image_data TEXT,
      notes TEXT,
      created_by VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_products (
      id INTEGER PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      category VARCHAR(120) NOT NULL,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      image_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS old_stock_items (
      id BIGINT PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      category VARCHAR(120) NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      stock_date VARCHAR(30),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE laundry_orders ADD COLUMN IF NOT EXISTS category VARCHAR(100) NOT NULL DEFAULT 'អាវយឺត (T-Shirt)';`);
  await pool.query(`ALTER TABLE laundry_orders ADD COLUMN IF NOT EXISTS item_count INTEGER NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE laundry_orders ADD COLUMN IF NOT EXISTS items_json JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE laundry_orders ADD COLUMN IF NOT EXISTS image_data TEXT;`);
  await pool.query(`ALTER TABLE laundry_orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(60);`);

  const defaultAdminUser = String(process.env.DEFAULT_ADMIN_USER || 'admin').trim();
  const defaultAdminPass = String(process.env.DEFAULT_ADMIN_PASS || 'Admin@123');
  const hash = await bcrypt.hash(defaultAdminPass, 10);

  const existingAdmin = await pool.query(
    `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
    [defaultAdminUser]
  );

  if (existingAdmin.rows.length === 0) {
    await pool.query(
      `INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [defaultAdminUser, 'អ្នកគ្រប់គ្រងហាង (Admin)', hash]
    );
    console.log(`✅ Default admin created -> username: "${defaultAdminUser}"`);
  } else if (process.env.FORCE_RESET_ADMIN === 'true') {
    await pool.query(
      `UPDATE users SET password_hash = $1, is_active = TRUE, role = 'admin' WHERE id = $2`,
      [hash, existingAdmin.rows[0].id]
    );
    console.log(`✅ Admin password reset for "${defaultAdminUser}"`);
  }

  console.log('✅ PostgreSQL tables (users, laundry_orders, catalog_products, old_stock_items) are ready.');
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ success: false, error: 'Database connection failed' });
  }
});

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({
    success: true,
    categories: STANDARD_CATEGORIES,
    statuses: ALLOWED_STATUSES
  });
});

app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const { id, name, category, price, image_url } = req.body;
    const itemId = Number(id);
    const cleanName = String(name || '').trim();
    const cleanCat = String(category || 'ផ្សេងៗ (Others)').trim();
    const cleanPrice = Number(price) >= 0 ? Number(price) : 0;
    const cleanImg = typeof image_url === 'string' ? image_url.trim() : null;

    if (!Number.isFinite(itemId) || itemId <= 0 || !cleanName) {
      return res.status(400).json({ success: false, error: 'Invalid product data' });
    }

    await pool.query(
      `
      INSERT INTO catalog_products (id, name, category, price, image_url, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          category = EXCLUDED.category,
          price = EXCLUDED.price,
          image_url = EXCLUDED.image_url,
          updated_at = NOW()
      `,
      [itemId, cleanName, cleanCat, cleanPrice, cleanImg]
    );

    res.json({ success: true, data: { id: itemId, name: cleanName, category: cleanCat, price: cleanPrice, image_url: cleanImg } });
  } catch (err) {
    console.error('POST /api/products error:', err);
    res.status(500).json({ success: false, error: 'Failed to save product' });
  }
});

app.post('/api/stock/opening', requireAuth, async (req, res) => {
  try {
    const { id, name, category, qty, price, stock_date, note } = req.body;
    const stockId = Number(id) || Date.now();
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ success: false, error: 'Stock item name is required' });
    }

    await pool.query(
      `
      INSERT INTO old_stock_items (id, name, category, qty, price, stock_date, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          category = EXCLUDED.category,
          qty = EXCLUDED.qty,
          price = EXCLUDED.price,
          stock_date = EXCLUDED.stock_date,
          note = EXCLUDED.note
      `,
      [
        stockId,
        cleanName,
        String(category || 'ផ្សេងៗ (Others)').trim(),
        Number.isFinite(Number(qty)) ? Number(qty) : 0,
        Number.isFinite(Number(price)) ? Number(price) : 0,
        stock_date ? String(stock_date).trim() : null,
        note ? String(note).trim() : null
      ]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('POST /api/stock/opening error:', err);
    res.status(500).json({ success: false, error: 'Failed to save old stock' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'សូមបញ្ចូល Username និង Password' });
    }

    const result = await pool.query(
      `SELECT id, username, full_name, password_hash, role, is_active FROM users WHERE LOWER(username) = LOWER($1)`,
      [String(username).trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'ឈ្មោះគណនី ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ' });
    }

    const user = result.rows[0];
    if (!user.is_active) {
      return res.status(403).json({ success: false, error: 'គណនីនេះត្រូវបានផ្អាកដំណើរការ' });
    }

    const valid = await bcrypt.compare(String(password), user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'ឈ្មោះគណនី ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    };

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.status(500).json({ success: false, error: 'មិនអាចរក្សា Session បានទេ' });
      }
      res.json({ success: true, user: req.session.user });
    });
  } catch (err) {
    console.error('POST /api/auth/login error:', err);
    res.status(500).json({ success: false, error: 'មានបញ្ហាក្នុងការ Login' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('laundry.sid');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.json({ success: true, user: null });
  }
  res.json({ success: true, user: req.session.user });
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        username,
        full_name,
        role,
        is_active,
        to_char(created_at AT TIME ZONE 'Asia/Phnom_Penh', 'DD/MM/YYYY HH24:MI') AS created_at_kh
      FROM users
      ORDER BY id ASC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('GET /api/users error:', err);
    res.status(500).json({ success: false, error: 'មិនអាចទាញបញ្ជីអ្នកប្រើប្រាស់បានទេ' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, full_name, password, role } = req.body;
    const cleanUser = String(username || '').trim();
    const cleanName = String(full_name || '').trim();
    const cleanPass = String(password || '');
    const cleanRole = role === 'admin' ? 'admin' : 'staff';

    if (!cleanUser || !cleanName || cleanPass.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'ត្រូវបំពេញ Username, ឈ្មោះពេញ និង Password យ៉ាងតិច ៦ តួអក្សរ'
      });
    }

    const exists = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [cleanUser]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Username នេះមានរួចហើយ' });
    }

    const hash = await bcrypt.hash(cleanPass, 10);
    const ins = await pool.query(
      `
      INSERT INTO users (username, full_name, password_hash, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, full_name, role, is_active, to_char(created_at AT TIME ZONE 'Asia/Phnom_Penh', 'DD/MM/YYYY HH24:MI') AS created_at_kh
      `,
      [cleanUser, cleanName, hash, cleanRole]
    );

    res.status(201).json({ success: true, data: ins.rows[0] });
  } catch (err) {
    console.error('POST /api/users error:', err);
    res.status(500).json({ success: false, error: 'មិនអាចបង្កើត User ថ្មីបានទេ' });
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { status, category, search } = req.query;
    const conditions = [];
    const values = [];

    if (status && status !== 'ALL') {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }

    if (category && category !== 'ALL') {
      values.push(category);
      const idx = values.length;
      conditions.push(`(category = $${idx} OR EXISTS (SELECT 1 FROM jsonb_array_elements(items_json) elem WHERE elem->>'category' = $${idx}))`);
    }

    if (search && String(search).trim() !== '') {
      values.push(`%${String(search).trim()}%`);
      const idx = values.length;
      conditions.push(`(order_code ILIKE $${idx} OR customer_name ILIKE $${idx} OR phone ILIKE $${idx} OR category ILIKE $${idx})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT
        *,
        to_char(created_at AT TIME ZONE 'Asia/Phnom_Penh', 'DD/MM/YYYY HH24:MI') AS created_at_kh
      FROM laundry_orders
      ${whereClause}
      ORDER BY created_at DESC, id DESC
    `;

    const result = await pool.query(query, values);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ success: false, error: 'Failed to load laundry orders' });
  }
});

// 🟢 រក្សាទុកឈ្មោះមុខទំនិញពិតប្រាកដដែលអ្នកជ្រើស (មិន force ប្តូរទៅជា អាវយឺត ទៀតទេ)
app.post('/api/orders', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { customer_name, phone, items, image_data, notes } = req.body;

    if (!customer_name || !phone || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'ត្រូវបញ្ចូលឈ្មោះអតិថិជន លេខទូរស័ព្ទ និងយ៉ាងហោចណាស់ ១ មុខទំនិញ'
      });
    }

    const cleanItems = items.map((it) => {
      const rawCat = String(it.category || '').trim();
      const cat = rawCat || STANDARD_CATEGORIES[0];
      const srv = String(it.service_type || 'បោក និងបត់ (Wash & Fold)').trim();
      const cnt = Number.isInteger(Number(it.item_count)) && Number(it.item_count) > 0 ? Number(it.item_count) : 1;
      const wt = Number(it.weight_kg) >= 0 ? Number(it.weight_kg) : 0;
      const pr = Number(it.price) >= 0 ? Number(it.price) : 0;
      return {
        category: cat,
        service_type: srv,
        item_count: cnt,
        weight_kg: wt,
        price: pr
      };
    });

    const totalCount = cleanItems.reduce((sum, x) => sum + x.item_count, 0);
    const totalWeight = cleanItems.reduce((sum, x) => sum + x.weight_kg, 0);
    const totalPrice = cleanItems.reduce((sum, x) => sum + x.price, 0);

    const summaryCategory =
      cleanItems.length === 1
        ? cleanItems[0].category
        : `${cleanItems[0].category} (+${cleanItems.length - 1} មុខទៀត)`;
    const summaryService =
      cleanItems.length === 1 ? cleanItems[0].service_type : 'ច្រើនសេវាកម្ម (Multi-item)';

    let cleanImage = null;
    if (typeof image_data === 'string' && image_data.startsWith('data:image/')) {
      cleanImage = image_data;
    }

    await client.query('BEGIN');

    const seqRes = await client.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_num FROM laundry_orders`);
    const nextNum = String(seqRes.rows[0].next_num).padStart(4, '0');
    const orderCode = `LND-${nextNum}`;

    const insertRes = await client.query(
      `
      INSERT INTO laundry_orders
        (order_code, customer_name, phone, category, service_type, item_count, weight_kg, price, items_json, status, image_data, notes, created_by)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'Pending', $10, $11, $12)
      RETURNING *, to_char(created_at AT TIME ZONE 'Asia/Phnom_Penh', 'DD/MM/YYYY HH24:MI') AS created_at_kh
      `,
      [
        orderCode,
        String(customer_name).trim(),
        String(phone).trim(),
        summaryCategory,
        summaryService,
        totalCount,
        totalWeight,
        totalPrice,
        JSON.stringify(cleanItems),
        cleanImage,
        notes ? String(notes).trim() : null,
        req.session.user.username
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/orders error:', err);
    res.status(500).json({ success: false, error: 'Failed to create laundry order' });
  } finally {
    client.release();
  }
});

app.patch('/api/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status value' });
    }

    const result = await pool.query(
      `
      UPDATE laundry_orders
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *, to_char(created_at AT TIME ZONE 'Asia/Phnom_Penh', 'DD/MM/YYYY HH24:MI') AS created_at_kh
      `,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/orders/:id/status error:', err);
    res.status(500).json({ success: false, error: 'Failed to update order status' });
  }
});

app.delete('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM laundry_orders WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, deletedId: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /api/orders/:id error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete order' });
  }
});

app.get('*', (req, res) => {
  const indexPath = fs.existsSync(path.join(publicDir, 'index.html'))
    ? path.join(publicDir, 'index.html')
    : path.join(__dirname, 'index.html');
  res.sendFile(indexPath);
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Laundry server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ Database init failed:', err);
    process.exit(1);
  });
