const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Only signup/login are actual brute-force targets, so only these get the
// strict limit. Routine calls like GET /me must NOT share this budget, or
// several genuine users behind the same office/home WiFi (same public IP)
// could end up locking each other out. 50 per 15 minutes per IP is still a
// serious barrier for a real password-guessing attack (which needs thousands
// of attempts), while comfortably handling a burst of real signups from one
// shared network.
const bruteForceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again later.' }
});

// Current logged-in user's full profile
router.get('/me', authRequired, (req, res) => {
  const user = db.prepare(`
    SELECT id, name, phone, area, building, floor, avatar, wallet_balance, rating, tasks_completed, tasks_posted
    FROM users WHERE id = ?
  `).get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user });
});

// Update profile (area/building/floor/avatar) — handy for onboarding tweaks
router.patch('/me', authRequired, (req, res) => {
  const { area, building, floor, avatar } = req.body;
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!current) return res.status(404).json({ error: 'User not found.' });

  db.prepare(`
    UPDATE users SET area = ?, building = ?, floor = ?, avatar = ? WHERE id = ?
  `).run(
    area ?? current.area,
    building ?? current.building,
    floor ?? current.floor,
    avatar ?? current.avatar,
    req.userId
  );

  const updated = db.prepare(`
    SELECT id, name, phone, area, building, floor, avatar, wallet_balance, rating, tasks_completed, tasks_posted
    FROM users WHERE id = ?
  `).get(req.userId);
  res.json({ user: updated });
});

router.post('/signup', bruteForceLimiter, async (req, res) => {
  const { name, phone, password, area, building, floor } = req.body;

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Name, phone and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) {
    return res.status(409).json({ error: 'An account with this phone number already exists.' });
  }

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);

  db.prepare(`
    INSERT INTO users (id, name, phone, password_hash, area, building, floor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, phone, passwordHash, area || null, building || null, floor || null);

  const token = jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '30d' });

  res.status(201).json({
    token,
    user: {
      id, name, phone, area, building, floor,
      avatar: null, wallet_balance: 0, rating: 5.0, tasks_completed: 0, tasks_posted: 0
    }
  });
});

router.post('/login', bruteForceLimiter, async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    return res.status(401).json({ error: 'Invalid phone number or password.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid phone number or password.' });
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      area: user.area,
      building: user.building,
      floor: user.floor,
      avatar: user.avatar,
      wallet_balance: user.wallet_balance,
      rating: user.rating,
      tasks_completed: user.tasks_completed,
      tasks_posted: user.tasks_posted
    }
  });
});

module.exports = router;
