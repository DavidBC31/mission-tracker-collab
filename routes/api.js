'use strict';

const express = require('express');
const config = require('../config');
const gmailSvc = require('../services/gmail');
const { analyzeMailbox } = require('../services/analyze');

const router = express.Router();

// Cache par utilisateur (clé = email) : { data, at }
const cache = new Map();

// --- Middleware d'authentification ---
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user || !req.session.tokens) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

// Construit un client Gmail et persiste les tokens rafraîchis en session
function gmailForRequest(req) {
  return gmailSvc.gmailClientFromSession(req.session.tokens, (merged) => {
    req.session.tokens = merged;
  });
}

// GET /api/me → infos utilisateur connecté (ou 401)
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  res.json({ user: req.session.user });
});

// GET /api/refresh → analyse Gmail + Claude (avec cache 5 min)
router.get('/refresh', requireAuth, async (req, res) => {
  const user = req.session.user;
  const force = req.query.force === 'true';
  const key = user.email;

  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < config.analysis.CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const { gmail } = gmailForRequest(req);
    const { tunnel1, tunnel2 } = await analyzeMailbox(gmail, user);

    const payload = {
      tunnel1,
      tunnel2,
      updatedAt: new Date().toISOString(),
      user: { name: user.name, email: user.email, picture: user.picture },
    };

    cache.set(key, { data: payload, at: Date.now() });
    res.json(payload);
  } catch (err) {
    console.error('[api] /refresh échec :', err.message);
    const code = err.code === 401 || err.code === 403 ? 401 : 500;
    res.status(code).json({
      error:
        code === 401
          ? 'Session Google expirée, reconnectez-vous.'
          : "Échec de l'analyse des e-mails.",
    });
  }
});

// POST /api/draft → crée un brouillon Gmail
router.post('/draft', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Champs to, subject et body requis' });
  }

  try {
    const { gmail } = gmailForRequest(req);
    const draftId = await gmailSvc.createDraft(gmail, { to, subject, body });
    res.json({ success: true, draftId });
  } catch (err) {
    console.error('[api] /draft échec :', err.message);
    res.status(500).json({ error: 'Échec de la création du brouillon' });
  }
});

module.exports = router;
