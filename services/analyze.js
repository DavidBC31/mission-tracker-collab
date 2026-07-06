'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const gmailSvc = require('./gmail');

const A = config.analysis;
const MODEL = config.anthropic.model;

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// --- Helpers ------------------------------------------------------------

const URGENCY_RANK = { normal: 0, medium: 1, high: 2 };

// Expéditeurs automatiques → jamais de relance
const AUTOMATED_FROM =
  /(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?@|newsletter@)/i;
// Invitations / réponses calendrier
const CALENDAR_SUBJECT =
  /^(invitation|accept[ée]e?|refus[ée]e?|annul[ée]e?|mise à jour|updated invitation|accepted|declined)\s*:/i;

function daysSince(internalDateMs) {
  return Math.floor((Date.now() - internalDateMs) / (24 * 60 * 60 * 1000));
}

function urgencyFromDays(days) {
  if (days > A.URGENCY_HIGH_DAYS) return 'high';
  if (days > A.URGENCY_MED_DAYS) return 'medium';
  return 'normal';
}

function maxUrgency(a, b) {
  const ra = URGENCY_RANK[a] != null ? URGENCY_RANK[a] : 0;
  const rb = URGENCY_RANK[b] != null ? URGENCY_RANK[b] : 0;
  const m = Math.max(ra, rb);
  return Object.keys(URGENCY_RANK).find((k) => URGENCY_RANK[k] === m);
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

/**
 * Reconstruit un item d'affichage depuis un enregistrement de cache :
 * jours d'attente et urgence sont recalculés à chaque fois (ils évoluent).
 */
function reviveItem(r) {
  const days = daysSince(r.lastMsgDate);
  return {
    threadId: r.threadId,
    tunnel: r.tunnel,
    name: r.name,
    email: r.email,
    subject: r.subject,
    date: formatDateFR(r.lastMsgDate),
    daysWaiting: days,
    task: r.task,
    urgency: maxUrgency(urgencyFromDays(days), r.urgencyAI),
    register: r.register || 'vous',
    body: r.body || '',
    relance: r.relance || '',
  };
}

// Pool de concurrence simple (JS mono-thread → pas de verrou nécessaire)
async function pool(items, worker, concurrency) {
  let i = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (i < items.length) {
        const idx = i;
        i += 1;
        try {
          await worker(items[idx], idx);
        } catch (err) {
          console.warn('[analyze] fil ignoré :', err.message);
        }
      }
    }
  );
  await Promise.all(runners);
}

// Contexte de conversation pour Claude : derniers messages, corps tronqués
function buildContext(messages, userEmail, userName) {
  return messages
    .slice(-5)
    .map((m) => {
      const who = isSentByUser(m, userEmail)
        ? `${userName} (moi)`
        : gmailSvc.extractName(m.from);
      const text = (m.body || m.snippet || '').slice(0, 600);
      return `[${who}] ${text}`;
    })
    .join('\n---\n')
    .slice(0, 3000);
}

// --- Appels Claude ------------------------------------------------------

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

async function claudeText(prompt, maxTokens) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return ((res.content[0] && res.content[0].text) || '').trim();
}

/**
 * Classification unique pour les deux tunnels + détection du registre tu/vous.
 */
async function classifyThread({ subject, context, lastIsUser, userName }) {
  const pendingRule = lastIsUser
    ? `true si ce dernier message envoyé par ${userName} attend une réponse ou une action du contact (question posée, demande, document attendu, proposition à valider…). false s'il ne nécessite aucune réponse (simple remerciement, information sans question, message de clôture, "bien reçu").`
    : `true si une action reste en attente côté ${userName} et qu'une relance est utile (tâche non terminée, sans confirmation finale, document non fourni, décision non prise). false si le fil est clos ou n'attend rien.`;

  const prompt = `Fil d'e-mail professionnel entre ${userName} et un contact.
Sujet : ${subject}
Dernier message : ${lastIsUser ? `envoyé par ${userName}, resté SANS réponse` : 'reçu du contact'}.
Conversation (du plus ancien au plus récent) :
${context}

Analyse :
1. "pending" : ${pendingRule}
2. "task" : description de ce qui est attendu, <150 caractères, en français.
3. "urgency" : "high", "medium" ou "normal" selon l'enjeu apparent du fil.
4. "register" : "tu" si ${userName} tutoie ce contact dans SES propres messages, sinon "vous".

Réponds UNIQUEMENT avec un JSON valide, sans texte autour :
{"pending":true/false,"task":"...","urgency":"high|medium|normal","register":"tu|vous"}`;

  const text = await claudeText(prompt, 250);
  return parseJsonLoose(text);
}

function toneInstructions(register) {
  return register === 'tu'
    ? 'Tutoie le contact — ils se tutoient dans leurs échanges. Ton cordial, direct et humain, comme entre collègues qui se connaissent.'
    : 'Vouvoie le contact — ils se vouvoient dans leurs échanges. Reste simple, chaleureux et direct : pas de style corporate rigide ni de formules ampoulées ("Je me permets de revenir vers vous"…).';
}

/** Génère une relance (appelée à la demande, pas pendant l'analyse). */
async function generateRelance({ name, subject, task, userName, register }) {
  const prompt = `Rédige un e-mail de relance en français, court (3-4 lignes), signé "${userName}".
${toneInstructions(register)}
Va à l'essentiel avec le sourire.
Contact : ${name}
Sujet original : ${subject}
Contexte : ${task}
Réponds uniquement avec le texte de l'email (sans objet, sans commentaire).`;
  return claudeText(prompt, 400);
}

/** Reformule une relance existante selon un mode. */
async function reformulateRelance({ current, mode, register, userName }) {
  const modes = {
    shorter: 'Raccourcis cet e-mail au maximum (2-3 lignes), sans perdre la demande.',
    formal: 'Rends cet e-mail un peu plus formel et professionnel, sans devenir rigide ni ampoulé.',
    rephrase: 'Reformule cet e-mail différemment : même ton, même longueur, autre angle.',
  };
  const prompt = `${modes[mode] || modes.rephrase}
${toneInstructions(register)}
Conserve la signature "${userName}".
E-mail actuel :
${current}

Réponds uniquement avec le nouveau texte de l'email.`;
  return claudeText(prompt, 400);
}

// --- Analyse principale -------------------------------------------------

/**
 * Analyse la boîte mail de l'utilisateur.
 * @param {object} gmail  client Gmail authentifié
 * @param {object} user   { name, email }
 * @param {object} opts   { userStore, onProgress(done,total), onItem(item) }
 *   - userStore : enregistrement store de l'utilisateur (muté : cache threads,
 *     statuts). C'est à l'appelant de le sauvegarder ensuite.
 * @returns {Promise<{tunnel1: Array, tunnel2: Array}>}
 */
async function analyzeMailbox(gmail, user, opts = {}) {
  const userStore = opts.userStore || null;
  const onProgress = opts.onProgress || (() => {});
  const onItem = opts.onItem || (() => {});
  const userEmail = (user.email || '').toLowerCase();

  const threadIds = await gmailSvc.searchThreads(gmail, {
    days: A.DAYS_WINDOW,
    max: A.MAX_THREADS,
  });

  const total = threadIds.length;
  let done = 0;
  const items = [];

  const keep = (item) => {
    items.push(item);
    onItem(item);
  };

  await pool(
    threadIds,
    async (threadId) => {
      try {
        const meta = await gmailSvc.getThreadMeta(gmail, threadId);
        const messages = [...meta.messages].sort(
          (a, b) => a.internalDate - b.internalDate
        );
        if (!messages.length) return;
        if (!messages.some((m) => isSentByUser(m, userEmail))) return;

        const lastMsg = messages[messages.length - 1];
        const lastIsUser = isSentByUser(lastMsg, userEmail);
        const contactHeader = lastIsUser ? lastMsg.to : lastMsg.from;
        const contactEmail = gmailSvc.extractEmail(contactHeader);
        if (!contactEmail || contactEmail === userEmail) return;

        // Filtres anti-bruit : automates, newsletters, calendrier
        if (AUTOMATED_FROM.test(contactEmail)) return;
        if (CALENDAR_SUBJECT.test(meta.subject)) return;
        if (!lastIsUser && lastMsg.listUnsubscribe) return;

        // Statuts utilisateur : traité / ignoré / reporté
        if (userStore) {
          const st = userStore.items[threadId];
          if (st) {
            if (st.lastMessageId === lastMsg.id) {
              if (st.status === 'done' || st.status === 'ignored') return;
              if (st.status === 'snoozed' && Date.now() < (st.snoozeUntil || 0)) return;
            } else {
              // Nouveau message depuis le classement → on réactive le fil
              delete userStore.items[threadId];
            }
          }
        }

        // Cache par fil : inchangé depuis la dernière analyse → aucun appel Claude
        if (userStore) {
          const cached = userStore.threads[threadId];
          if (cached && cached.lastMessageId === lastMsg.id) {
            if (cached.pending) keep(reviveItem(cached));
            return;
          }
        }

        // Fil nouveau ou modifié → corps complet + classification Claude
        const full = await gmailSvc.getThread(gmail, threadId);
        const fullMessages = [...full.messages].sort(
          (a, b) => a.internalDate - b.internalDate
        );
        const fullLast = fullMessages[fullMessages.length - 1];
        const context = buildContext(fullMessages, userEmail, user.name);

        let cls = null;
        try {
          cls = await classifyThread({
            subject: full.subject,
            context,
            lastIsUser,
            userName: user.name,
          });
        } catch (err) {
          console.warn('[analyze] classification échouée :', err.message);
        }

        if (!cls) {
          // Dégradé : Tunnel 1 conservé par prudence (non mis en cache →
          // retenté à la prochaine analyse), Tunnel 2 écarté.
          if (!lastIsUser) return;
          keep(
            reviveItem({
              threadId,
              tunnel: 1,
              name: gmailSvc.extractName(contactHeader),
              email: contactEmail,
              subject: full.subject,
              lastMsgDate: fullLast.internalDate,
              task: 'Aucune réponse reçue. Relance nécessaire.',
              urgencyAI: 'normal',
              register: 'vous',
              body: fullLast.body || '',
              relance: '',
            })
          );
          return;
        }

        const record = {
          threadId,
          lastMessageId: lastMsg.id,
          analyzedAt: Date.now(),
          pending: !!cls.pending,
          tunnel: lastIsUser ? 1 : 2,
          name: gmailSvc.extractName(contactHeader),
          email: contactEmail,
          subject: full.subject,
          lastMsgDate: fullLast.internalDate,
          task: String(cls.task || 'Action en attente.').slice(0, 200),
          urgencyAI: URGENCY_RANK[cls.urgency] != null ? cls.urgency : 'normal',
          register: cls.register === 'tu' ? 'tu' : 'vous',
          body: fullLast.body || '',
          relance: '',
        };

        if (userStore) userStore.threads[threadId] = record;
        if (record.pending) keep(reviveItem(record));
      } finally {
        done += 1;
        onProgress(done, total);
      }
    },
    A.CONCURRENCY
  );

  // Purge du cache : fils sortis de la fenêtre d'analyse
  if (userStore) {
    const active = new Set(threadIds);
    for (const id of Object.keys(userStore.threads)) {
      if (!active.has(id)) delete userStore.threads[id];
    }
    for (const id of Object.keys(userStore.items)) {
      if (!active.has(id)) delete userStore.items[id];
    }
  }

  const byPriority = (a, b) =>
    URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] ||
    b.daysWaiting - a.daysWaiting;

  return {
    tunnel1: items.filter((i) => i.tunnel === 1).sort(byPriority),
    tunnel2: items.filter((i) => i.tunnel === 2).sort(byPriority),
  };
}

module.exports = { analyzeMailbox, generateRelance, reformulateRelance };
