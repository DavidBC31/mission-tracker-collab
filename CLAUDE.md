# Suivi Mission Collaborateur

Application d'analyse d'e-mails avec détection de tâches en attente.

## Règles métier
- Tunnel 1 : envoyé sans réponse → relance directe
- Tunnel 2 : réponse reçue, tâche non finalisée → relance contextuelle
- Fenêtre : 45 jours, limite 30 fils
- Urgence : HIGH > 14j, MEDIUM > 7j, NORMAL sinon

## Stack
Node.js + Express + Google OAuth SSO + Gmail API + Claude API (haiku) + Cloudflare Tunnel

## Design
Charte « Bleu Citron » (Apple / iOS 18) — voir le PDF de DA. Tokens repris dans `public/index.html` :
fond #F5F5F7 + dégradés radiaux, glassmorphism, primaire #1450E2, boutons pilule, cartes rounded-2xl.
Tunnel 1 = rouge Apple #FF3B30, Tunnel 2 = orange Apple #FF9500.

## Commandes
- npm start → lance le serveur (port 3000)
- GET /api/refresh?force=true → force analyse
- POST /api/draft → crée brouillon Gmail
- GET /api/me → user connecté ou 401

## Points d'attention
- Chaque utilisateur a ses propres tokens OAuth en session
- Cache 5 min par utilisateur (Map en mémoire, clé = email)
- Les appels Claude sont séquentiels (1 par fil) pour éviter rate-limit
- Modèle Claude : claude-haiku-4-5-20251001 (défini dans config.js)
- Aucune base de données : tout vit en session/mémoire

## Structure
- `server.js` — entrée Express, sessions, statique
- `config.js` — env + paramètres d'analyse
- `routes/auth.js` — OAuth Google (/auth/google, /auth/callback, /auth/logout)
- `routes/api.js` — /api/me, /api/refresh, /api/draft (+ cache)
- `services/gmail.js` — wrapper Gmail multi-user (search, getThread, createDraft)
- `services/analyze.js` — logique Tunnel 1/2 + appels Claude
- `public/index.html` — dashboard SPA self-contained
