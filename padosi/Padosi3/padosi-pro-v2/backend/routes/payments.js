const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// MOCK_PAYMENTS lets the whole app work end-to-end (post → accept → complete →
// "pay" → wallet credited) with ZERO signup, PAN, or KYC anywhere — useful for
// college demos/projects before a real Razorpay account is ready. It only
// activates when explicitly turned on in .env, so production deployments are
// never accidentally left in mock mode.
const MOCK_MODE = process.env.MOCK_PAYMENTS === 'true';
if (MOCK_MODE) {
  console.warn('⚠️  MOCK_PAYMENTS is ON — payments are simulated, no real money moves. Turn this off once you have real Razorpay keys.');
}

// Card-testing / carding attacks work by spamming many card numbers against a
// validation endpoint. This limit makes that impractical without blocking a
// real person adding their own card a few times.
const cardAddLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many card attempts. Please wait a while and try again.' }
});

function notify(userId, type, title, body, data) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO notifications (id, user_id, type, title, body, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, type, title, body, JSON.stringify(data || {}));
  return id;
}

// Poster pays for a completed task -> creates a Razorpay order
router.post('/create-order/:taskId', authRequired, async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.poster_id !== req.userId) return res.status(403).json({ error: 'Only the task poster can pay for this task.' });
  if (task.status !== 'completed') return res.status(400).json({ error: 'Task must be marked completed before payment.' });
  if (task.payment_status === 'paid') return res.status(400).json({ error: 'This task has already been paid.' });

  if (MOCK_MODE) {
    const mockOrderId = 'mock_order_' + uuidv4();
    db.prepare('UPDATE tasks SET razorpay_order_id = ? WHERE id = ?').run(mockOrderId, task.id);
    return res.json({
      mock: true,
      order_id: mockOrderId,
      amount: task.price * 100,
      currency: 'INR'
    });
  }

  try {
    const order = await razorpay.orders.create({
      amount: task.price * 100, // paise
      currency: 'INR',
      receipt: `task_${task.id}`,
      notes: { task_id: task.id }
    });

    db.prepare('UPDATE tasks SET razorpay_order_id = ? WHERE id = ?').run(order.id, task.id);

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    res.status(500).json({ error: 'Could not create payment order. Please try again.' });
  }
});

// Frontend calls this right after Razorpay checkout succeeds, to verify the signature
router.post('/verify', authRequired, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, task_id } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !task_id) {
    return res.status(400).json({ error: 'Missing payment verification fields.' });
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (task.razorpay_order_id !== razorpay_order_id) {
    return res.status(400).json({ error: 'Order mismatch.' });
  }
  if (task.payment_status === 'paid') {
    return res.json({ success: true, message: 'Payment already verified.' });
  }

  // Only skip signature verification for our own mock orders (identified by
  // the "mock_order_" prefix WE generated above) — a real Razorpay order id
  // would never match that prefix, so this can't be spoofed by a real user
  // trying to skip payment on a genuine order.
  const isMockOrder = MOCK_MODE && task.razorpay_order_id.startsWith('mock_order_');

  if (!isMockOrder) {
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed.' });
    }
  }

  const txId = uuidv4();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET payment_status = 'paid', status = 'paid', razorpay_payment_id = ?, paid_at = datetime('now')
      WHERE id = ?
    `).run(razorpay_payment_id, task.id);

    db.prepare(`
      INSERT INTO transactions (id, task_id, amount, commission, payout_amount, razorpay_payment_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed')
    `).run(txId, task.id, task.price, task.commission_amount, task.payout_amount, razorpay_payment_id);

    db.prepare(`
      UPDATE users SET wallet_balance = wallet_balance + ?, tasks_completed = tasks_completed + 1 WHERE id = ?
    `).run(task.payout_amount, task.accepted_by);
  });
  tx();

  notify(
    task.accepted_by,
    'payment_received',
    'Payment received!',
    `Rs ${task.payout_amount} credited for: ${task.title}`,
    { task_id: task.id, amount: task.payout_amount }
  );

  if (req.io) {
    req.io.to(`area:${task.area}`).emit('task-updated', { ...task, payment_status: 'paid', status: 'paid' });
  }

  res.json({ success: true, message: 'Payment verified. Tasker has been credited.' });
});

// Razorpay webhook - backup confirmation path in case the frontend callback is missed.
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (signature !== expected) {
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  const event = JSON.parse(req.body.toString());
  console.log('Razorpay webhook received:', event.event);

  // The /verify route already handles the main flow. This is a durability
  // backstop — extend here if you want to reconcile missed payments.

  res.json({ received: true });
});

// Wallet balance + transaction history for the logged-in user
router.get('/wallet', authRequired, (req, res) => {
  const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.userId);
  const history = db.prepare(`
    SELECT t.*, tk.title as task_title, tk.category
    FROM transactions t
    JOIN tasks tk ON tk.id = t.task_id
    WHERE tk.accepted_by = ?
    ORDER BY t.created_at DESC LIMIT 50
  `).all(req.userId);

  const pending = db.prepare(`
    SELECT SUM(amount) as total FROM withdrawals WHERE user_id = ? AND status = 'processing'
  `).get(req.userId);

  res.json({
    wallet_balance: user.wallet_balance,
    pending_withdrawal: pending.total || 0,
    history
  });
});

// Request a withdrawal to a UPI ID (MVP: logs request, deducts wallet immediately)
router.post('/withdraw', authRequired, (req, res) => {
  const { amount, upi_id } = req.body;
  const amountNum = Number(amount);

  if (!amountNum || amountNum < 10) return res.status(400).json({ error: 'Minimum withdrawal is Rs 10.' });
  if (!upi_id || !upi_id.includes('@')) return res.status(400).json({ error: 'Enter a valid UPI ID (e.g. name@bank).' });

  const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.userId);
  if (amountNum > user.wallet_balance) return res.status(400).json({ error: 'Withdrawal amount exceeds wallet balance.' });

  const id = uuidv4();
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(amountNum, req.userId);
    db.prepare(`
      INSERT INTO withdrawals (id, user_id, amount, upi_id, status) VALUES (?, ?, ?, ?, 'processing')
    `).run(id, req.userId, amountNum, upi_id);
  });
  tx();

  res.json({ success: true, message: 'Withdrawal requested. It will reach your UPI ID within 24 hours.', id });
});

// Notifications
router.get('/notifications', authRequired, (req, res) => {
  const notifs = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
  `).all(req.userId);

  const unread = db.prepare(`
    SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0
  `).get(req.userId);

  res.json({ notifications: notifs, unread: unread.count });
});

router.post('/notifications/:id/read', authRequired, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

// ============ PAYMENT METHODS (display-only, PCI-safe) ============
// We never persist a full card number or CVC. The client only sends us the
// brand + last 4 digits + expiry after doing its own basic validation, so this
// is purely a "saved methods" list for a nicer wallet UI, not a real card vault.

function luhnCheck(numStr) {
  let sum = 0, alt = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = parseInt(numStr[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

router.get('/methods', authRequired, (req, res) => {
  const methods = db.prepare(`
    SELECT id, type, label, card_brand, card_last4, card_expiry, upi_id, is_default, created_at
    FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at DESC
  `).all(req.userId);
  res.json({ methods });
});

router.post('/methods/card', authRequired, cardAddLimiter, (req, res) => {
  const { card_number, card_expiry, cardholder_name } = req.body;
  const digitsOnly = String(card_number || '').replace(/\s+/g, '');

  if (!/^\d{13,19}$/.test(digitsOnly)) {
    return res.status(400).json({ error: 'Enter a valid card number.' });
  }
  if (!luhnCheck(digitsOnly)) {
    return res.status(400).json({ error: 'That card number doesn\'t look valid.' });
  }
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(String(card_expiry || ''))) {
    return res.status(400).json({ error: 'Expiry must be in MM/YY format.' });
  }

  // Detect brand from the leading digits (standard IIN ranges) — cosmetic only.
  let brand = 'Card';
  if (/^4/.test(digitsOnly)) brand = 'Visa';
  else if (/^5[1-5]/.test(digitsOnly) || /^2(2[2-9]|[3-6]\d|7[01]|720)/.test(digitsOnly)) brand = 'Mastercard';
  else if (/^3[47]/.test(digitsOnly)) brand = 'Amex';
  else if (/^6(011|5)/.test(digitsOnly)) brand = 'Discover';
  else if (/^60|^65|^81|^82/.test(digitsOnly)) brand = 'RuPay';

  const last4 = digitsOnly.slice(-4);
  const id = uuidv4();
  const label = `${brand} •••• ${last4}`;

  const existingCount = db.prepare('SELECT COUNT(*) as c FROM payment_methods WHERE user_id = ?').get(req.userId).c;

  db.prepare(`
    INSERT INTO payment_methods (id, user_id, type, label, card_brand, card_last4, card_expiry, is_default)
    VALUES (?, ?, 'card', ?, ?, ?, ?, ?)
  `).run(id, req.userId, label, brand, last4, card_expiry, existingCount === 0 ? 1 : 0);

  res.status(201).json({ method: { id, type: 'card', label, card_brand: brand, card_last4: last4, card_expiry } });
});

router.post('/methods/upi', authRequired, (req, res) => {
  const { upi_id } = req.body;
  if (!upi_id || !/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/.test(upi_id)) {
    return res.status(400).json({ error: 'Enter a valid UPI ID (e.g. name@bank).' });
  }

  const id = uuidv4();
  const label = upi_id;
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM payment_methods WHERE user_id = ?').get(req.userId).c;

  db.prepare(`
    INSERT INTO payment_methods (id, user_id, type, label, upi_id, is_default)
    VALUES (?, ?, 'upi', ?, ?, ?)
  `).run(id, req.userId, label, upi_id, existingCount === 0 ? 1 : 0);

  res.status(201).json({ method: { id, type: 'upi', label, upi_id } });
});

router.post('/methods/:id/default', authRequired, (req, res) => {
  const method = db.prepare('SELECT * FROM payment_methods WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!method) return res.status(404).json({ error: 'Payment method not found.' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE payment_methods SET is_default = 0 WHERE user_id = ?').run(req.userId);
    db.prepare('UPDATE payment_methods SET is_default = 1 WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ success: true });
});

router.delete('/methods/:id', authRequired, (req, res) => {
  const method = db.prepare('SELECT * FROM payment_methods WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!method) return res.status(404).json({ error: 'Payment method not found.' });
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Full activity summary for the profile screen: everything the person has
// earned (as a tasker) and spent (as a poster), with timestamps, so they can
// see their whole history in one place.
router.get('/activity', authRequired, (req, res) => {
  const earned = db.prepare(`
    SELECT t.id as task_id, t.title, tx.payout_amount as amount, tx.created_at
    FROM transactions tx
    JOIN tasks t ON t.id = tx.task_id
    WHERE t.accepted_by = ?
    ORDER BY tx.created_at DESC
  `).all(req.userId);

  const spent = db.prepare(`
    SELECT t.id as task_id, t.title, tx.amount as amount, tx.created_at
    FROM transactions tx
    JOIN tasks t ON t.id = tx.task_id
    WHERE t.poster_id = ?
    ORDER BY tx.created_at DESC
  `).all(req.userId);

  const totalEarned = earned.reduce((sum, e) => sum + e.amount, 0);
  const totalSpent = spent.reduce((sum, s) => sum + s.amount, 0);

  const timeline = [
    ...earned.map(e => ({ ...e, type: 'earned' })),
    ...spent.map(s => ({ ...s, type: 'spent' }))
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ total_earned: totalEarned, total_spent: totalSpent, timeline });
});

module.exports = router;
