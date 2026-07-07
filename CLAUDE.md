# Suivi Mission Collaborateur

Application d'analyse d'e-mails avec détection de tâches en attente.

## Règles métier
- Tunnel 1 : envoyé sans réponse ET le mail attend une réponse (classification Claude) → relance
- Tunnel 2 : réponse reçue, tâche non finalisée (classification Claude sur le corps) → relance contextuelle
- Filtres anti-bruit : expéditeurs automatiques (noreply…), newsletters (List-Unsubscribe), invitations calendrier
- Fenêtre : 45 jours, limite 30 fils
- Urgence : max(HIGH > 14j / MEDIUM > 7j / NORMAL, avis Claude) — recalculée à chaque affichage
- Registre tu/vous détecté dans le fil et reflété dans la relance
- Statuts par fil : traité / ignoré / reporté (snooze) — réactivé si nouveau message dans le fil

## Stack
Node.js + Express + Google OAuth SSO + Gmail API + Claude API (haiku) + Cloudflare Tunnel

## Design
Charte « Bleu Citron » (Apple / iOS 18) — voir le PDF de DA. Tokens repris dans `public/index.html` :
fond #F5F5F7 + dégradés radiaux, glassmorphism, primaire #1450E2, boutons pilule, cartes rounded-2xl.
Tunnel 1 = rouge Apple #FF3B30, Tunnel 2 = orange Apple #FF9500. Dark mode via prefers-color-scheme.

## API
- GET  /api/me → user + prefs (ou 401)
- GET  /api/refresh (?force=true, ?cachedOnly=true) → JSON bloquant (compat scripts)
- GET  /api/refresh/stream (?force=true) → SSE : progress / item / done / busy / error
- POST /api/relance { threadId, mode?: generate|shorter|formal|rephrase, current? } → relance à la demande
- POST /api/item/status { threadId, status: done|ignored|snoozed|active, snoozeDays? }
- POST /api/send { threadId, to, subject, body } → envoi direct + marque traité
- POST /api/draft { to, subject, body } → brouillon Gmail
- POST /api/prefs { digest: bool }

## Points d'attention
- SSO restreint au domaine ALLOWED_GOOGLE_DOMAIN (défaut bleucitron.net) — vérifié serveur au callback
- Chaque utilisateur a ses tokens OAuth en session + copie chiffrée (AES-256-GCM, clé dérivée de
  SESSION_SECRET) dans data/ pour le digest matinal
- Cache payload 5 min par utilisateur (Map mémoire) + cache d'analyse PAR FIL persisté dans data/
  (clé = threadId + dernier message) → fils inchangés = zéro appel Claude
- Analyse parallélisée (pool de 4, config.analysis.CONCURRENCY) ; relances générées À LA DEMANDE
  (au dépli de la carte), jamais pendant l'analyse
- Digest quotidien à DIGEST_HOUR (8h Paris) via services/digest.js — envoyé dans le Gmail de
  l'utilisateur, opt-out via 🔔 dans le dashboard ; sert aussi de préchauffage du cache
- Modèle Claude : claude-haiku-4-5-20251001 (défini dans config.js)
- Pas de base de données : sessions en mémoire (memorystore), données par utilisateur dans
  data/u_*.json (gitignoré)
- Le scope gmail.compose couvre brouillons ET envoi direct (pas de re-consentement nécessaire)

## Structure
- `server.js` — entrée Express, sessions (memorystore), statique, démarrage digest
- `config.js` — env + paramètres d'analyse + domaine autorisé + digest
- `routes/auth.js` — OAuth Google (hd + vérif domaine, enrôlement store)
- `routes/api.js` — routes API (+ cache payload, verrou anti-analyses concurrentes)
- `services/gmail.js` — wrapper Gmail multi-user (meta/full, extraction corps, draft, send)
- `services/analyze.js` — classification 2 tunnels + tu/vous, cache par fil, pool, relances
- `services/store.js` — persistance JSON par utilisateur (tokens chiffrés, statuts, cache)
- `services/digest.js` — récap matinal planifié
- `public/index.html` — dashboard SPA self-contained (SSE, filtres, statuts, dark mode, a11y,
  FAQ intégrée via la modale « ? » — à tenir à jour si les règles métier changent)
