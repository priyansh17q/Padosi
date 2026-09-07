require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
const paymentRoutes = require('./routes/payments');

const app = express();
const server = http.createServer(app);

// Railway (and most hosting platforms) sit your app behind a reverse proxy.
// Without this, Express sees every visitor as coming from the PROXY's IP,
// which would make our rate limiters lump ALL real users together — meaning
// one busy user could accidentally lock out everyone else. Trusting the
// first proxy hop makes Express read the real visitor IP from the
// X-Forwarded-For header instead.
app.set('trust proxy', 1);

// CORS_ORIGIN lets you lock this down to your real domain in production
// (e.g. CORS_ORIGIN=https://yourapp.up.railway.app). Defaults to "*" for easy
// local development, but you should set it once you have a real domain.
const corsOrigin = process.env.CORS_ORIGIN || '*';
const io = new Server(server, { cors: { origin: corsOrigin } });

// Security headers (helmet sets sane defaults: no X-Powered-By, clickjacking
// protection, MIME sniffing protection, etc). CSP is relaxed here because the
// app loads Google Fonts, Socket.IO and Razorpay's checkout script from CDNs.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Global rate limit — generous, just to stop abuse
// This is a broad anti-abuse ceiling, not the main defense — the real
// protections are the tighter per-route limiters below (signup/login, card
// add). Many genuine users can share one public IP (office WiFi, a college
// hostel, a mobile carrier's NAT), so this needs to be generous enough not to
// punish them while still stopping a determined scraper doing tens of
// thousands of requests.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use(limiter);

app.use(cors({ origin: corsOrigin }));

// Webhook route needs the raw body for signature verification, so it's
// mounted before the global json() parser.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Attach io to every request so route handlers can emit real-time events
app.use((req, res, next) => {
  req.io = io;
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/payments', paymentRoutes);

app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'Padosi Pro',
  version: '2.0.0',
  mock_payments: process.env.MOCK_PAYMENTS === 'true'
}));

// Serve the frontend (PWA)
app.use(express.static(path.join(__dirname, 'frontend')));

// Explicit landing page route
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'landing.html'));
});

// Socket.io: clients join an "area" room so they only get updates relevant to them
io.on('connection', (socket) => {
  socket.on('join-area', (area) => {
    if (typeof area === 'string' && area.trim()) {
      socket.join(`area:${area.trim()}`);
    }
  });
  // Join a task-specific room to receive that task's chat messages live
  socket.on('join-task', (taskId) => {
    if (typeof taskId === 'string' && taskId.trim()) {
      socket.join(`task:${taskId.trim()}`);
    }
  });
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Padosi Pro running on http://localhost:${PORT}`);
});

module.exports = { io };
