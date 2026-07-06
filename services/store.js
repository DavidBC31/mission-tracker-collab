'use strict';

/**
 * Persistance légère par utilisateur — un fichier JSON par utilisateur dans data/.
 * Contient : profil, préférences, tokens OAuth (chiffrés AES-256-GCM),
 * statuts d'éléments (traité / ignoré / reporté) et cache d'analyse par fil.
 *
 * Volontairement synchrone (fichiers < 100 Ko, trafic faible) et sans dépendance.
 * Écritures atomiques (tmp + rename). Dernière écriture gagnante en cas de
 * concurrence requête/digest — acceptable à cette échelle.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const DIR = config.dataDir;
fs.mkdirSync(DIR, { recursive: true });

// Clé de chiffrement dérivée du secret de session
const KEY = crypto.scryptSync(config.session.secret, 'sm-token-store', 32);

function fileFor(email) {
  const h = crypto
    .createHash('sha1')
    .update(String(email).toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return path.join(DIR, `u_${h}.json`);
}

function defaults(email) {
  return {
    email: String(email).toLowerCase(),
    name: '',
    picture: null,
    prefs: { digest: true },
    lastDigestDate: null,
    tokensEnc: null,
    // threadId -> { status: 'done'|'ignored'|'snoozed', snoozeUntil, lastMessageId }
    items: {},
    // threadId -> résultat d'analyse (voir services/analyze.js)
    threads: {},
  };
}

function load(email) {
  try {
    const raw = fs.readFileSync(fileFor(email), 'utf-8');
    return { ...defaults(email), ...JSON.parse(raw) };
  } catch (_) {
    return defaults(email);
  }
}

function save(email, data) {
  const file = fileFor(email);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// --- Chiffrement des tokens ---

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf-8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8'));
}

function saveTokens(email, tokens) {
  const d = load(email);
  d.tokensEnc = encrypt(tokens);
  save(email, d);
}

function loadTokens(email) {
  const d = load(email);
  if (!d.tokensEnc) return null;
  try {
    return decrypt(d.tokensEnc);
  } catch (_) {
    return null; // secret changé ou fichier corrompu → re-login nécessaire
  }
}

function listUsers() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith('u_') && f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { load, save, saveTokens, loadTokens, listUsers };
