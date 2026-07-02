'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const gmailSvc = require('./gmail');

const A = config.analysis;
const MODEL = config.anthropic.model;

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// --- Helpers ------------------------------------------------------------

function daysSince(internalDateMs) {
  return Math.floor((Date.now() - internalDateMs) / (24 * 60 * 60 * 1000));
}

function urgencyFromDays(days) {
  if (days > A.URGENCY_HIGH_DAYS) return 'high';
  if (days > A.URGENCY_MED_DAYS) return 'medium';
  return 'normal';
}

function formatDateFR(ms) {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function isSentByUser(msg, userEmail) {
  if (msg.labelIds && msg.labelIds.includes('SENT')) return true;
  return gmailSvc.extractEmail(msg.from) === userEmail;
}

/** Concatène un extrait des derniers messages pour le contexte Claude. */
function buildSnippet(messages, maxMessages = 4) {
  return messages
    .slice(-maxMessages)
    .map((m) => {
      const who = gmailSvc.extractName(m.from);
      return `[${who}] ${m.snippet}`;
    })
    .join('\n')
    .slice(0, 1500);
}

// --- Appels Claude ------------------------------------------------------

async function classifyTunnel2({ subject, snippet, userName }) {
  const prompt = `Fil d'e-mail professionnel.
Sujet : ${subject}
Conversation (extraits) : ${snippet}
Une ACTION reste-t-elle en attente côté ${userName} (non terminée, sans confirmation finale) ?
Réponds UNIQUEMENT avec un JSON valide, sans texte autour :
{"pending":true/false,"task":"description <150 chars","urgency":"high|medium|normal"}`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (res.content[0] && res.content[0].text) || '';
  return parseJsonLoose(text);
}

async function generateRelance({ contactName, subject, taskDescription, userName }) {
  const prompt = `Rédige un e-mail de relance en français, court (3-4 lignes), signé "${userName}".
Ton : cordial, direct et humain — comme un message entre collègues qui se connaissent.
Tutoie le contact (emploie "tu"). Évite le style corporate, rigide ou trop formel :
pas de "Je me permets de revenir vers vous", pas de formules ampoulées. Va à l'essentiel avec le sourire.
Contact : ${contactName}
Sujet original : ${subject}
Contexte : ${taskDescription}
Réponds uniquement avec le texte de l'email (sans objet, sans commentaire).`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return ((res.content[0] && res.content[0].text) || '').trim();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

// --- Analyse principale -------------------------------------------------

/**
 * Analyse la boîte mail de l'utilisateur et retourne tunnel1 / tunnel2.
 * @param {object} gmail client Gmail authentifié
 * @param {object} user { name, email }
 */
async function analyzeMailbox(gmail, user) {
  const userEmail = (user.email || '').toLowerCase();
  const threadIds = await gmailSvc.searchThreads(gmail, {
    days: A.DAYS_WINDOW,
    max: A.MAX_THREADS,
  });

  const tunnel1 = [];
  const tunnel2 = [];

  for (const threadId of threadIds) {
    let thread;
    try {
      thread = await gmailSvc.getThread(gmail, threadId);
    } catch (err) {
      console.warn(`[analyze] thread ${threadId} ignoré :`, err.message);
      continue;
    }

    const messages = [...thread.messages].sort(
      (a, b) => a.internalDate - b.internalDate
    );
    if (messages.length === 0) continue;

    // L'utilisateur doit avoir participé (au moins un message envoyé)
    const userParticipated = messages.some((m) => isSentByUser(m, userEmail));
    if (!userParticipated) continue;

    const lastMsg = messages[messages.length - 1];
    const lastIsUser = isSentByUser(lastMsg, userEmail);
    const days = daysSince(lastMsg.internalDate);

    if (lastIsUser) {
      // --- Tunnel 1 : envoyé, aucune réponse ---
      const contactEmail = gmailSvc.extractEmail(lastMsg.to);
      if (!contactEmail || contactEmail === userEmail) continue;
      const contactName = gmailSvc.extractName(lastMsg.to);
      const task = 'Aucune réponse reçue. Relance nécessaire.';

      let relance = '';
      try {
        relance = await generateRelance({
          contactName,
          subject: thread.subject,
          taskDescription: task,
          userName: user.name,
        });
      } catch (err) {
        console.warn('[analyze] relance T1 échouée :', err.message);
      }

      tunnel1.push({
        name: contactName,
        email: contactEmail,
        subject: thread.subject,
        date: formatDateFR(lastMsg.internalDate),
        task,
        urgency: urgencyFromDays(days),
        relance,
        body: lastMsg.body || '',
      });
    } else {
      // --- Tunnel 2 : réponse reçue → analyse sémantique ---
      const contactEmail = gmailSvc.extractEmail(lastMsg.from);
      if (!contactEmail || contactEmail === userEmail) continue;
      const contactName = gmailSvc.extractName(lastMsg.from);

      let cls = null;
      try {
        cls = await classifyTunnel2({
          subject: thread.subject,
          snippet: buildSnippet(messages),
          userName: user.name,
        });
      } catch (err) {
        console.warn('[analyze] classification T2 échouée :', err.message);
        continue;
      }

      if (!cls || !cls.pending) continue;

      const task = (cls.task || 'Action en attente.').slice(0, 200);
      // Urgence : on prend le max entre le temps écoulé et l'avis de Claude
      const urgency = mergeUrgency(urgencyFromDays(days), cls.urgency);

      let relance = '';
      try {
        relance = await generateRelance({
          contactName,
          subject: thread.subject,
          taskDescription: task,
          userName: user.name,
        });
      } catch (err) {
        console.warn('[analyze] relance T2 échouée :', err.message);
      }

      tunnel2.push({
        name: contactName,
        email: contactEmail,
        subject: thread.subject,
        date: formatDateFR(lastMsg.internalDate),
        task,
        urgency,
        relance,
        body: lastMsg.body || '',
      });
    }
  }

  return { tunnel1, tunnel2 };
}

function mergeUrgency(a, b) {
  const rank = { normal: 0, medium: 1, high: 2 };
  const ra = rank[a] != null ? rank[a] : 0;
  const rb = rank[b] != null ? rank[b] : 0;
  const max = Math.max(ra, rb);
  return Object.keys(rank).find((k) => rank[k] === max);
}

module.exports = { analyzeMailbox };
