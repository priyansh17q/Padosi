const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DB_PATH lets you point this at a persistent Railway Volume in production
// (e.g. DB_PATH=/data/padosi.sqlite). Falls back to a local file for dev.
const dbFile = process.env.DB_PATH
  ? process.env.DB_PATH
  : path.join(__dirname, 'padosi.sqlite');

const dbDir = path.dirname(dbFile);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log(`Padosi DB file: ${dbFile}`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  area TEXT,
  building TEXT,
  floor TEXT,
  avatar TEXT,
  wallet_balance INTEGER DEFAULT 0,
  rating REAL DEFAULT 5.0,
  tasks_completed INTEGER DEFAULT 0,
  tasks_posted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  upi_id TEXT NOT NULL,
  status TEXT DEFAULT 'processing',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  poster_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'other',
  area TEXT NOT NULL,
  building TEXT,
  floor TEXT,
  price INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL,
  payout_amount INTEGER NOT NULL,
  status TEXT DEFAULT 'open',
  accepted_by TEXT,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  payment_status TEXT DEFAULT 'unpaid',
  image TEXT,
  pickup_address TEXT,
  item_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  completed_at TEXT,
  paid_at TEXT,
  FOREIGN KEY (poster_id) REFERENCES users(id),
  FOREIGN KEY (accepted_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  payout_amount INTEGER NOT NULL,
  razorpay_payment_id TEXT,
  status TEXT DEFAULT 'created',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewee_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Payment methods are DISPLAY-ONLY records. We deliberately never store a full card
-- number or CVC here (that would be a serious security/compliance problem) — only
-- the last 4 digits and brand, purely so the wallet screen can show "Visa •••• 4242".
-- Real charges always go through Razorpay's own secure checkout.
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('card','upi')),
  label TEXT NOT NULL,
  card_brand TEXT,
  card_last4 TEXT,
  card_expiry TEXT,
  upi_id TEXT,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_area ON tasks(area);
`);

// Lightweight migration for DBs created before pickup_address/item_name existed
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes('pickup_address')) {
  db.exec('ALTER TABLE tasks ADD COLUMN pickup_address TEXT');
}
if (!taskCols.includes('item_name')) {
  db.exec('ALTER TABLE tasks ADD COLUMN item_name TEXT');
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);

-- Task-specific chat between the poster and whoever accepted it. Only visible
-- once someone has accepted (no point chatting on an open task with no tasker
-- yet), and only to the two people involved.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
`);

module.exports = db;
