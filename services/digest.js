'use strict';

/**
 * Digest matinal : chaque jour à l'heure configurée (heure de Paris),
 * analyse la boîte de chaque utilisateur inscrit (tokens stockés) et lui
 * envoie un récapitulatif des relances en attente — dans sa propre boîte Gmail.
 *
 * Effet secondaire vertueux : l'analyse tourne en tâche de fond, donc le
 * cache par fil est chaud quand l'utilisateur ouvre le dashboard.
 */

const config = require('../config');
const store = require('./store');
const gmailSvc = require('./gmail');
const { analyzeMailbox } = require('./analyze');

const URGENCY_COLOR = { high: '#FF3B30', medium: '#FF9500', normal: '#86868B' };
const URGENCY_LABEL = { high: 'Urgent', medium: 'À suivre', normal: 'Normal' };

function parisNow() {
  const fmt = new Intl.DateTimeFormat('fr-CA', {
    timeZone: config.digest.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
  };
}

function rowHTML(it) {
  return `<tr>
    <td style="padding:10px 14px;border-bottom:1px solid #eee;">
      <strong style="color:#1d1d1f;">${escapeHtml(it.name)}</strong><br>
      <span style="color:#86868b;font-size:13px;">${escapeHtml(it.subject)}</span>
    </td>
    <td style="padding:10px 14px;border-bottom:1px solid #eee;white-space:nowrap;text-align:right;">
      <span style="color:${URGENCY_COLOR[it.urgency]};font-weight:600;">${it.daysWaiting} j</span><br>
      <span style="color:#86868b;font-size:12px;">${URGENCY_LABEL[it.urgency]}</span>
    </td>
  </tr>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function digestHTML(name, tunnel1, tunnel2) {
  const firstName = (name || '').split(/\s+/)[0] || '';
  const section = (title, color, items) =>
    items.length
      ? `<h3 style="color:${color};font-size:15px;margin:24px 0 6px;">${title} (${items.length})</h3>
         <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;">
           ${items.map(rowHTML).join('')}
         </table>`
      : '';

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f5f5f7;">
    <h2 style="color:#1d1d1f;font-size:20px;margin:0 0 4px;">☀️ Bonjour${firstName ? ` ${escapeHtml(firstName)}` : ''},</h2>
    <p style="color:#86868b;font-size:14px;margin:0 0 8px;">Voici les relances en attente ce matin :</p>
    ${section('🔴 En attente stricte — sans réponse', '#FF3B30', tunnel1)}
    ${section('🟠 Tâches non finalisées', '#FF9500', tunnel2)}
    <p style="margin:28px 0 0;">
      <a href="${config.app.url}" style="display:inline-block;background:#1450E2;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 22px;border-radius:9999px;">Ouvrir le suivi de mission</a>
    </p>
    <p style="color:#86868b;font-size:11px;margin-top:20px;">Digest automatique — désactivable depuis le dashboard (🔔).</p>
  </div>`;
}

async function runDigests() {
  const { date, hour } = parisNow();
  if (hour < config.digest.hour) return;

  for (const u of store.listUsers()) {
    if (!u.prefs || !u.prefs.digest) continue;
    if (u.lastDigestDate === date) continue;

    try {
      const tokens = store.loadTokens(u.email);
      if (!tokens || !tokens.refresh_token) continue;

      const rec = store.load(u.email);
      const gmail = gmailSvc.gmailClientFromSession(tokens, (merged) =>
        store.saveTokens(u.email, merged)
      );

      const { tunnel1, tunnel2 } = await analyzeMailbox(
        gmail,
        { name: rec.name || u.email, email: u.email },
        { userStore: rec }
      );

      // Marqué AVANT l'envoi : garantit un seul cycle d'analyse par jour
      rec.lastDigestDate = date;
      store.save(u.email, rec);

      const total = tunnel1.length + tunnel2.length;
      if (!total) {
        console.log(`[digest] ${u.email} : rien à relancer, pas d'envoi`);
        continue;
      }

      await gmailSvc.sendMessage(gmail, {
        to: u.email,
        subject: `📋 ${total} relance${total > 1 ? 's' : ''} en attente aujourd'hui`,
        body: digestHTML(rec.name, tunnel1, tunnel2),
        html: true,
      });
      console.log(`[digest] envoyé à ${u.email} (${total} éléments)`);
    } catch (err) {
      console.warn(`[digest] échec pour ${u.email} :`, err.message);
      if (/invalid_grant/i.test(err.message || '')) {
        // Tokens révoqués → on les purge, re-login nécessaire
        const rec = store.load(u.email);
        rec.tokensEnc = null;
        store.save(u.email, rec);
      }
    }
  }
}

function start() {
  setInterval(() => {
    runDigests().catch((err) => console.warn('[digest]', err.message));
  }, 60 * 1000);
  console.log(
    `[digest] planifié chaque jour à ${config.digest.hour}h (${config.digest.timeZone})`
  );
}

module.exports = { start, runDigests };
