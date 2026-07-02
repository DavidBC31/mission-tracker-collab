'use strict';

const { google } = require('googleapis');
const config = require('../config');

/**
 * Construit un client Gmail authentifié à partir des tokens de session.
 * Si l'access_token est rafraîchi, on renvoie les nouveaux tokens via onTokens()
 * pour que l'appelant puisse les re-stocker en session.
 */
function gmailClientFromSession(tokens, onTokens) {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  oauth2.setCredentials(tokens);

  oauth2.on('tokens', (newTokens) => {
    // newTokens.refresh_token n'est présent que la 1ère fois — on fusionne.
    const merged = { ...tokens, ...newTokens };
    if (typeof onTokens === 'function') onTokens(merged);
  });

  return {
    gmail: google.gmail({ version: 'v1', auth: oauth2 }),
    auth: oauth2,
  };
}

function decodeHeader(headers, name) {
  const h = (headers || []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : '';
}

function decodeB64Url(data) {
  return Buffer.from(
    data.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf-8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// Cherche récursivement la 1ère part d'un type MIME donné
function findPart(parts, mimeType) {
  for (const p of parts || []) {
    if (p.mimeType === mimeType && p.body && p.body.data) return p;
    if (p.parts) {
      const nested = findPart(p.parts, mimeType);
      if (nested) return nested;
    }
  }
  return null;
}

// Extrait le corps texte d'un message (préfère text/plain, sinon text/html nettoyé)
function extractBody(payload) {
  if (!payload) return '';
  let text = '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    text = decodeB64Url(payload.body.data);
  } else if (payload.parts) {
    const plain = findPart(payload.parts, 'text/plain');
    if (plain) text = decodeB64Url(plain.body.data);
    else {
      const html = findPart(payload.parts, 'text/html');
      if (html) text = stripHtml(decodeB64Url(html.body.data));
    }
  } else if (payload.body && payload.body.data) {
    text = decodeB64Url(payload.body.data);
    if (payload.mimeType === 'text/html') text = stripHtml(text);
  }
  return cleanBody(text);
}

// Nettoie : coupe les citations de réponse, normalise les espaces, limite la taille
function cleanBody(text) {
  if (!text) return '';
  let out = text.replace(/\r\n/g, '\n');

  // Coupe à la 1ère citation ("Le ... a écrit :", "On ... wrote:", ligne "> ")
  const markers = [
    /\nLe .+? a écrit\s*:/,
    /\nOn .+? wrote\s*:/,
    /\n-{2,}\s*Message d'origine\s*-{2,}/i,
    /\nDe\s*:.+\nEnvoyé\s*:/i,
    /\n_{5,}/,
  ];
  for (const m of markers) {
    const idx = out.search(m);
    if (idx > 40) out = out.slice(0, idx);
  }

  out = out
    .split('\n')
    .filter((l) => !/^\s*>/.test(l)) // retire les lignes citées
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (out.length > 4000) out = out.slice(0, 4000) + '\n…';
  return out;
}

/**
 * Recherche les fils contenant des messages ENVOYÉS dans la fenêtre temporelle.
 * @returns {Promise<string[]>} liste d'IDs de threads
 */
async function searchThreads(gmail, { days, max }) {
  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Format Gmail : YYYY/MM/DD
  const q = `in:sent after:${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;

  const res = await gmail.users.threads.list({
    userId: 'me',
    q,
    maxResults: max,
  });

  return (res.data.threads || []).map((t) => t.id);
}

/**
 * Récupère un fil complet, normalisé.
 * @returns {Promise<{id, subject, messages: Array}>}
 */
async function getThread(gmail, threadId) {
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full', // 'full' pour récupérer le corps des messages
  });

  const thread = res.data;
  const rawMessages = thread.messages || [];

  const messages = rawMessages.map((m) => {
    const headers = m.payload && m.payload.headers;
    return {
      id: m.id,
      labelIds: m.labelIds || [],
      from: decodeHeader(headers, 'From'),
      to: decodeHeader(headers, 'To'),
      subject: decodeHeader(headers, 'Subject'),
      date: decodeHeader(headers, 'Date'),
      internalDate: parseInt(m.internalDate || '0', 10),
      snippet: m.snippet || '',
      body: extractBody(m.payload),
    };
  });

  const subject =
    (messages[0] && messages[0].subject) || '(sans objet)';

  return { id: threadId, subject, messages };
}

/**
 * Crée un brouillon dans le Gmail de l'utilisateur connecté.
 */
async function createDraft(gmail, { to, subject, body }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeRFC2047(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  const raw = Buffer.from(lines.join('\r\n'), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });

  return res.data.id;
}

// Encode un sujet non-ASCII pour l'en-tête MIME
function encodeRFC2047(str) {
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  const b64 = Buffer.from(str, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/** Extrait l'adresse e-mail d'un en-tête "Nom <email>" */
function extractEmail(headerValue) {
  const m = /<([^>]+)>/.exec(headerValue || '');
  if (m) return m[1].trim().toLowerCase();
  return (headerValue || '').trim().toLowerCase();
}

/** Extrait le nom affiché d'un en-tête "Nom <email>" */
function extractName(headerValue) {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(headerValue || '');
  if (m) return m[1].trim();
  // pas de nom → on dérive du local-part de l'email
  const email = extractEmail(headerValue);
  const local = email.split('@')[0] || email;
  return local
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  gmailClientFromSession,
  searchThreads,
  getThread,
  createDraft,
  extractEmail,
  extractName,
};
