'use strict';

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
    MAX_THREADS: 30,
    URGENCY_HIGH_DAYS: 14,
    URGENCY_MED_DAYS: 7,
    CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes par utilisateur
  },
};

module.exports = config;
