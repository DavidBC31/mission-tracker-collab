'use strict';

const express = require('express');
const config = require('../config');
const gmailSvc = require('../services/gmail');
const store = require('../services/store');
const {
  analyzeMailbox,
  generateRelance,
  reformulateRelance,
} = require('../services/analyze');

const router = express.Router();

// Cache du payload par utilisateur (clé = email) : { data, at }
const payloadCache = new Map();
// Analyses en cours (une seule à la fois par utilisateur)
const inflight = new Set();

function sweepCache() {
  const now = Date.now();
  for (const [k, v] of payloadCache) {
    if (now - v.at > config.analysis.CACHE_TTL_MS) payloadCache.delete(k);
  }
}

// --- Middleware d'authentification ---
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user || !req.session.tokens) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
}

// Client Gmail lié à la session ; les tokens rafraîchis sont re-persistés
// en session ET dans le store (pour le digest)
function gmailForRequest(req) {
  const email = req.session.user.email;
  return gmailSvc.gmailClientFromSession(req.session.tokens, (merged) => {
    req.session.tokens = merged;
    try {
      store.saveTokens(email, merged);
    } catch (_) {
      /* non bloquant */
    }
  });
}

// Lance l'analyse complète et met à jour cache + store
async function runAnalysis(req, hooks = {}) {
  const user = req.session.user;
  const rec = store.load(user.email);
  const gmail = gmailForRequest(req);

  const { tunnel1, tunnel2 } = await analyzeMailbox(gmail, user, {
    userStore: rec,
    ...hooks,
  });
  store.save(user.email, rec);

  const payload = {
    tunnel1,
    tunnel2,
    updatedAt: new Date().toISOString(),
    user: { name: user.name, email: user.email, picture: user.picture },
  };
  payloadCache.set(user.email, { data: payload, at: Date.now() });
  return payload;
}

// Retire un élément du payload en cache (statut changé / envoyé)
function dropFromCache(email, threadId) {
  const c = payloadCache.get(email);
  if (!c) return;
  c.data.tunnel1 = c.data.tunnel1.filter((i) => i.threadId !== threadId);
  c.data.tunnel2 = c.data.tunnel2.filter((i) => i.threadId !== threadId);
}

// --- Routes -------------------------------------------------------------

// GET /api/me → utilisateur connecté + préférences (ou 401)
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  const rec = store.load(req.session.user.email);
  res.json({ user: req.session.user, prefs: rec.prefs });
});

// GET /api/refresh → analyse (JSON bloquant, conservé pour compat/scripts)
//   ?cachedOnly=true → renvoie le cache immédiatement (jamais d'analyse)
//   ?force=true      → ignore le cache
router.get('/refresh', requireAuth, async (req, res) => {
  sweepCache();
  const user = req.session.user;
  const cached = payloadCache.get(user.email);

  if (req.query.cachedOnly === 'true') {
    return res.json(
      cached
        ? cached.data
        : { tunnel1: [], tunnel2: [], updatedAt: null, empty: true, user }
    );
  }

  const force = req.query.force === 'true';
  if (!force && cached && Date.now() - cached.at < config.analysis.CACHE_TTL_MS) {
    return res.json(cached.data);
  }
  if (inflight.has(user.email)) {
    return res.status(409).json({ error: 'Analyse déjà en cours' });
  }

  inflight.add(user.email);
  try {
    res.json(await runAnalysis(req));
  } catch (err) {
    console.error('[api] /refresh échec :', err.message);
    const code = err.code === 401 || err.code === 403 ? 401 : 500;
    res.status(code).json({
      error:
        code === 401
          ? 'Session Google expirée, reconnectez-vous.'
          : "Échec de l'analyse des e-mails.",
    });
  } finally {
    inflight.delete(user.email);
  }
});

// GET /api/refresh/stream → analyse en Server-Sent Events
// Événements : progress {done,total} · item {…} · done {payload} · busy · error
router.get('/refresh/stream', requireAuth, async (req, res) => {
  const user = req.session.user;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);

  sweepCache();
  const force = req.query.force === 'true';
  const cached = payloadCache.get(user.email);
  if (!force && cached && Date.now() - cached.at < config.analysis.CACHE_TTL_MS) {
    send('done', cached.data);
    return res.end();
  }
  if (inflight.has(user.email)) {
    send('busy');
    return res.end();
  }

  inflight.add(user.email);
  try {
    const payload = await runAnalysis(req, {
      onProgress: (done, total) => send('progress', { done, total }),
      onItem: (item) => send('item', item),
    });
    send('done', payload);
  } catch (err) {
    console.error('[api] /refresh/stream échec :', err.message);
    send('error', { message: "Échec de l'analyse des e-mails." });
  } finally {
    inflight.delete(user.email);
    res.end();
  }
});

// POST /api/relance → génère ou reformule la relance d'un fil (à la demande)
// Body : { threadId, mode?: 'generate'|'shorter'|'formal'|'rephrase', current?,
//          name?, subject?, task?, register? }  (fallback si fil non caché)
router.post('/relance', requireAuth, async (req, res) => {
  const user = req.session.user;
  const { threadId, mode, current } = req.body || {};
  if (!threadId) return res.status(400).json({ error: 'threadId requis' });

  const rec = store.load(user.email);
  const t = rec.threads[threadId] || null;
  const ctx = {
    name: (t && t.name) || req.body.name,
    subject: (t && t.subject) || req.body.subject,
    task: (t && t.task) || req.body.task,
    register: (t && t.register) || (req.body.register === 'tu' ? 'tu' : 'vous'),
  };
  if (!ctx.name || !ctx.subject) {
    return res.status(404).json({ error: 'Fil inconnu' });
  }

  try {
    let text;
    if (mode && mode !== 'generate' && current) {
      text = await reformulateRelance({
        current,
        mode,
        register: ctx.register,
        userName: user.name,
      });
    } else {
      text = await generateRelance({ ...ctx, userName: user.name });
    }

    if (t) {
      t.relance = text;
      store.save(user.email, rec);
    }
    res.json({ relance: text });
  } catch (err) {
    console.error('[api] /relance échec :', err.message);
    res.status(500).json({ error: 'Échec de la rédaction de la relance' });
  }
});

// POST /api/item/status → traiter / ignorer / reporter / réactiver un élément
// Body : { threadId, status: 'done'|'ignored'|'snoozed'|'active', snoozeDays? }
router.post('/item/status', requireAuth, (req, res) => {
  const user = req.session.user;
  const { threadId, status, snoozeDays } = req.body || {};
  const valid = ['done', 'ignored', 'snoozed', 'active'];
  if (!threadId || !valid.includes(status)) {
    return res.status(400).json({ error: 'threadId et status valides requis' });
  }

  const rec = store.load(user.email);
  if (status === 'active') {
    delete rec.items[threadId];
  } else {
    rec.items[threadId] = {
      status,
      lastMessageId: (rec.threads[threadId] || {}).lastMessageId || null,
      snoozeUntil:
        status === 'snoozed'
          ? Date.now() + (parseInt(snoozeDays, 10) || 7) * 24 * 60 * 60 * 1000
          : null,
    };
  }
  store.save(user.email, rec);
  dropFromCache(user.email, threadId);
  res.json({ success: true });
});

// POST /api/send → envoie directement la relance et marque le fil traité
// Body : { threadId, to, subject, body }
router.post('/send', requireAuth, async (req, res) => {
  const user = req.session.user;
  const { threadId, to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Champs to, subject et body requis' });
  }

  try {
    const gmail = gmailForRequest(req);
    const messageId = await gmailSvc.sendMessage(gmail, { to, subject, body });

    if (threadId) {
      const rec = store.load(user.email);
      rec.items[threadId] = {
        status: 'done',
        lastMessageId: (rec.threads[threadId] || {}).lastMessageId || null,
        snoozeUntil: null,
      };
      store.save(user.email, rec);
      dropFromCache(user.email, threadId);
    }
    res.json({ success: true, messageId });
  } catch (err) {
    console.error('[api] /send échec :', err.message);
    res.status(500).json({ error: "Échec de l'envoi" });
  }
});

// POST /api/draft → crée un brouillon Gmail
router.post('/draft', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Champs to, subject et body requis' });
  }

  try {
    const gmail = gmailForRequest(req);
    const draftId = await gmailSvc.createDraft(gmail, { to, subject, body });
    res.json({ success: true, draftId });
  } catch (err) {
    console.error('[api] /draft échec :', err.message);
    res.status(500).json({ error: 'Échec de la création du brouillon' });
  }
});

// POST /api/prefs → préférences utilisateur (digest matinal)
router.post('/prefs', requireAuth, (req, res) => {
  const user = req.session.user;
  const rec = store.load(user.email);
  if (typeof req.body.digest === 'boolean') {
    rec.prefs.digest = req.body.digest;
  }
  store.save(user.email, rec);
  res.json({ success: true, prefs: rec.prefs });
});

module.exports = router;
