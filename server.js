'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);

const config = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const digest = require('./services/digest');

const app = express();

// Derrière Cloudflare Tunnel : faire confiance au proxy pour secure cookies / protocole
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));

// --- Sessions (stockage serveur en mémoire) ---
app.use(
  session({
    name: 'sm.sid',
    secret: config.session.secret,
    store: new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.isProd, // HTTPS uniquement en prod
      sameSite: 'lax', // 'lax' nécessaire pour le redirect OAuth retour
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
    },
  })
);

// --- Routes ---
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

// --- Statique (dashboard SPA) ---
app.use(express.static(path.join(__dirname, 'public')));

// Toute autre route renvoie l'app (le frontend gère l'état login/dashboard)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Gestion d'erreurs ---
app.use((err, req, res, next) => {
  console.error('[server] Erreur non gérée :', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

app.listen(config.port, () => {
  console.log(`\n📋 Suivi Mission Collaborateur`);
  console.log(`   ➜ http://localhost:${config.port}`);
  console.log(`   Mode : ${config.isProd ? 'production' : 'development'}`);
  if (config.google.allowedDomain) {
    console.log(`   SSO restreint à : @${config.google.allowedDomain}\n`);
  }
  digest.start();
});
