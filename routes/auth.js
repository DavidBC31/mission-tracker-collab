'use strict';

const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');

const config = require('../config');
const store = require('../services/store');

const router = express.Router();

function makeOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

// GET /auth/google → redirige vers le consentement Google
router.get('/google', (req, res) => {
  const oauth2 = makeOAuthClient();
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const url = oauth2.generateAuthUrl({
    access_type: 'offline', // nécessaire pour obtenir un refresh_token
    prompt: 'consent', // force le refresh_token même après 1ère autorisation
    scope: config.google.scopes,
    state,
    // Pré-filtre Google sur le domaine de l'entreprise (revérifié au callback)
    hd: config.google.allowedDomain || undefined,
  });

  res.redirect(url);
});

// GET /auth/callback → échange le code contre des tokens, crée la session
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?auth_error=' + encodeURIComponent(error));
  }
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?auth_error=invalid_state');
  }
  delete req.session.oauthState;

  try {
    const oauth2 = makeOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // Récupère le profil utilisateur
    const oauth2api = google.oauth2({ version: 'v2', auth: oauth2 });
    const { data: profile } = await oauth2api.userinfo.get();

    // Restriction au domaine de l'entreprise (le paramètre hd de l'URL
    // OAuth n'est qu'indicatif — la vérification serveur fait foi)
    const domain = (profile.email || '').split('@')[1] || '';
    if (
      config.google.allowedDomain &&
      domain.toLowerCase() !== config.google.allowedDomain
    ) {
      return res.redirect('/?auth_error=domain');
    }

    req.session.tokens = tokens;
    req.session.user = {
      name: profile.name || profile.email,
      email: profile.email,
      picture: profile.picture || null,
    };

    // Enrôlement pour le digest matinal : profil + tokens chiffrés sur disque
    try {
      const rec = store.load(profile.email);
      rec.name = profile.name || profile.email;
      rec.picture = profile.picture || null;
      store.save(profile.email, rec);
      store.saveTokens(profile.email, tokens);
    } catch (err) {
      console.warn('[auth] enrôlement store échoué :', err.message);
    }

    res.redirect('/');
  } catch (err) {
    console.error('[auth] Échec callback OAuth :', err.message);
    res.redirect('/?auth_error=token_exchange_failed');
  }
});

// GET /auth/logout → détruit la session
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sm.sid');
    res.redirect('/');
  });
});

module.exports = router;
