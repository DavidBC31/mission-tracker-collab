'use strict';

const path = require('path');
require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.warn(`[config] ⚠ Variable d'environnement manquante : ${name}`);
  }
  return v;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  isProd: process.env.NODE_ENV === 'production',

  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    // Restriction SSO au domaine de l'entreprise ('' = ouvert à tous)
    allowedDomain: (process.env.ALLOWED_GOOGLE_DOMAIN !== undefined
      ? process.env.ALLOWED_GOOGLE_DOMAIN
      : 'bleucitron.net').trim().toLowerCase(),
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: 'claude-haiku-4-5-20251001',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  },

  // Paramètres métier d'analyse
  analysis: {
    DAYS_WINDOW: 45,
    // Assez large pour couvrir réellement la fenêtre (le cache par fil rend
    // les analyses répétées quasi gratuites) ; les fils sont triés du plus
    // récent au plus ancien par Gmail, une limite trop basse tronque la fenêtre
    MAX_THREADS: parseInt(process.env.ANALYSIS_MAX_THREADS || '250', 10),
    URGENCY_HIGH_DAYS: 14,
    URGENCY_MED_DAYS: 7,
    CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes par utilisateur
    CONCURRENCY: 4, // fils analysés en parallèle (Gmail + Claude)
  },

  digest: {
    hour: parseInt(process.env.DIGEST_HOUR || '8', 10),
    timeZone: 'Europe/Paris',
  },

  app: {
    url: process.env.APP_URL || '',
  },

  dataDir: path.join(__dirname, 'data'),
};

// URL publique par défaut : déduite du redirect URI OAuth
if (!config.app.url) {
  try {
    config.app.url = new URL(config.google.redirectUri).origin;
  } catch (_) {
    config.app.url = `http://localhost:${config.port}`;
  }
}

module.exports = config;
