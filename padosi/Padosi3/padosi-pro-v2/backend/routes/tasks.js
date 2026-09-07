const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
const COMMISSION_PERCENT = Number(process.env.COMMISSION_PERCENT || 10);
// 'send' = bhejna hai (courier a parcel from pickup to drop)
// 'buy'  = kharid ke laana hai (tasker purchases an item and delivers it)
// 'print' = assignment/notes print-outs ya xerox — very common on campus
const VALID_CATEGORIES = ['delivery', 'send', 'buy', 'print', 'laundry', 'cleaning', 'tech', 'errand', 'other'];

function notify(userId, type, title, body, data) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO notifications (id, user_id, type, title, body, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, type, title, body, JSON.stringify(data || {}));
  return id;
}

// Real-time task feed with filters: area, status, search text, price range
router.get('/', authRequired, (req, res) => {
  const { area, status, q, min, max } = req.query;

  let query = `
    SELECT tasks.*, u.name as poster_name, u.rating as poster_rating, u.avatar as poster_avatar
    FROM tasks
    JOIN users u ON u.id = tasks.poster_id
    WHERE 1=1
  `;
  const params = [];

  if (area) {
    query += ' AND tasks.area = ?';
    params.push(area);
  }
  if (status) {
    query += ' AND tasks.status = ?';
    params.push(status);
  } else {
    query += " AND tasks.status = 'open'";
  }
  if (q) {
    query += ' AND (tasks.title LIKE ? OR tasks.description LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (min) {
    query += ' AND tasks.price >= ?';
    params.push(Number(min));
  }
  if (max) {
    query += ' AND tasks.price <= ?';
    params.push(Number(max));
  }

  query += ' ORDER BY tasks.created_at DESC LIMIT 50';

  const tasks = db.prepare(query).all(...params);
  res.json({ tasks });
});

router.get('/mine/posted', authRequired, (req, res) => {
  const tasks = db.prepare(`
    SELECT tasks.*, u.name as accepted_by_name
    FROM tasks
    LEFT JOIN users u ON u.id = tasks.accepted_by
    WHERE poster_id = ?
    ORDER BY created_at DESC
  `).all(req.userId);
  res.json({ tasks });
});

router.get('/mine/accepted', authRequired, (req, res) => {
  const tasks = db.prepare(`
    SELECT tasks.*, u.name as poster_name, u.phone as poster_phone
    FROM tasks
    JOIN users u ON u.id = tasks.poster_id
    WHERE accepted_by = ?
    ORDER BY created_at DESC
  `).all(req.userId);
  res.json({ tasks });
});

router.post('/', authRequired, (req, res) => {
  const { title, description, area, building, floor, price, category, image, pickup_address, item_name } = req.body;

  if (!title || !area || !price) {
    return res.status(400).json({ error: 'Title, area and price are required.' });
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 1) {
    return res.status(400).json({ error: 'Price must be a positive number.' });
  }
  const cat = VALID_CATEGORIES.includes(category) ? category : 'other';

  // "Send" tasks need a pickup address so the tasker knows where to collect the item from
  if (cat === 'send' && !pickup_address) {
    return res.status(400).json({ error: 'Pickup address is required for a send/courier task.' });
  }
  // "Buy" tasks need to say what item is being bought
  if (cat === 'buy' && !item_name) {
    return res.status(400).json({ error: 'Please specify what item needs to be bought.' });
  }

  const id = uuidv4();
  const commission = Math.round((priceNum * COMMISSION_PERCENT) / 100);
  const payout = priceNum - commission;

  db.prepare(`
    INSERT INTO tasks (id, poster_id, title, description, category, area, building, floor, price, commission_amount, payout_amount, image, pickup_address, item_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, title, description || '', cat, area, building || null, floor || null, priceNum, commission, payout, image || null, pickup_address || null, item_name || null);

  db.prepare('UPDATE users SET tasks_posted = tasks_posted + 1 WHERE id = ?').run(req.userId);

  const task = db.prepare(`
    SELECT tasks.*, u.name as poster_name, u.rating as poster_rating, u.avatar as poster_avatar
    FROM tasks JOIN users u ON u.id = tasks.poster_id WHERE tasks.id = ?
  `).get(id);

  if (req.io) {
    req.io.to(`area:${area}`).emit('new-task', task);
  }

  res.status(201).json({ task });
});

router.post('/:id/accept', authRequired, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'This task is no longer open.' });
  if (task.poster_id === req.userId) return res.status(400).json({ error: 'You cannot accept your own task.' });

  db.prepare(`
    UPDATE tasks SET status = 'accepted', accepted_by = ?, accepted_at = datetime('now') WHERE id = ?
  `).run(req.userId, task.id);

  const accepter = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  notify(task.poster_id, 'task_accepted', 'Task accepted!', `${accepter.name} accepted your task: ${task.title}`, { task_id: task.id });

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  if (req.io) req.io.to(`area:${task.area}`).emit('task-updated', updated);

  res.json({ task: updated });
});

// Cancel a task — only the poster can do this, and only while it's still
// open (no one has accepted it yet). Once someone has started working on it,
// cancelling needs a conversation, not a button — keep this simple and safe.
router.post('/:id/cancel', authRequired, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.poster_id !== req.userId) return res.status(403).json({ error: 'Only the task poster can cancel this.' });
  if (task.status !== 'open') return res.status(400).json({ error: 'This task can no longer be cancelled — someone may have already accepted it.' });

  db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run(task.id);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  if (req.io) req.io.to(`area:${task.area}`).emit('task-updated', updated);

  res.json({ task: updated });
});

router.post('/:id/complete', authRequired, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.accepted_by !== req.userId) return res.status(403).json({ error: 'Only the assigned tasker can mark this complete.' });
  if (task.status !== 'accepted') return res.status(400).json({ error: 'Task must be in accepted state.' });

  db.prepare(`
    UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?
  `).run(task.id);

  const tasker = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  notify(task.poster_id, 'task_completed', 'Task completed!', `${tasker.name} marked your task as done. Please pay Rs ${task.price}.`, { task_id: task.id });

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  if (req.io) req.io.to(`area:${task.area}`).emit('task-updated', updated);

  res.json({ task: updated });
});

// Review after payment
router.post('/:id/review', authRequired, (req, res) => {
  const { rating, comment } = req.body;
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5.' });
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.payment_status !== 'paid') return res.status(400).json({ error: 'Task must be paid before reviewing.' });
  if (task.poster_id !== req.userId && task.accepted_by !== req.userId) {
    return res.status(403).json({ error: 'Only participants of this task can review.' });
  }

  const revieweeId = task.poster_id === req.userId ? task.accepted_by : task.poster_id;
  if (!revieweeId) return res.status(400).json({ error: 'No one to review.' });

  const existing = db.prepare('SELECT id FROM reviews WHERE task_id = ? AND reviewer_id = ?').get(task.id, req.userId);
  if (existing) return res.status(409).json({ error: 'You already reviewed this task.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO reviews (id, task_id, reviewer_id, reviewee_id, rating, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, task.id, req.userId, revieweeId, ratingNum, comment || '');

  const avg = db.prepare('SELECT AVG(rating) as avg FROM reviews WHERE reviewee_id = ?').get(revieweeId);
  db.prepare('UPDATE users SET rating = ? WHERE id = ?').run(Number(avg.avg).toFixed(2), revieweeId);

  res.json({ success: true, review: { id, rating: ratingNum, comment } });
});

// Chat between poster and tasker — only once someone has accepted, and only
// the two people involved can see or send messages.
router.get('/:id/messages', authRequired, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.poster_id !== req.userId && task.accepted_by !== req.userId) {
    return res.status(403).json({ error: 'Only the poster and the assigned tasker can view this chat.' });
  }
  if (!task.accepted_by) return res.json({ messages: [] });

  const messages = db.prepare(`
    SELECT m.*, u.name as sender_name FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.task_id = ? ORDER BY m.created_at ASC LIMIT 200
  `).all(task.id);
  res.json({ messages });
});

router.post('/:id/messages', authRequired, (req, res) => {
  const { body } = req.body;
  const text = String(body || '').trim();
  if (!text) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (text.length > 1000) return res.status(400).json({ error: 'Message is too long.' });

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.poster_id !== req.userId && task.accepted_by !== req.userId) {
    return res.status(403).json({ error: 'Only the poster and the assigned tasker can chat here.' });
  }
  if (!task.accepted_by) return res.status(400).json({ error: 'Chat opens once someone accepts this task.' });

  const id = uuidv4();
  db.prepare(`INSERT INTO messages (id, task_id, sender_id, body) VALUES (?, ?, ?, ?)`)
    .run(id, task.id, req.userId, text);

  const sender = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);
  const message = { id, task_id: task.id, sender_id: req.userId, sender_name: sender.name, body: text, created_at: new Date().toISOString() };

  // Notify the other participant in real time
  const otherUserId = task.poster_id === req.userId ? task.accepted_by : task.poster_id;
  if (req.io) req.io.to(`task:${task.id}`).emit('new-message', message);

  res.status(201).json({ message });
});

module.exports = router;
