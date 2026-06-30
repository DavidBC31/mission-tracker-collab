# 📋 Suivi Mission Collaborateur

Tableau de bord d'analyse d'e-mails qui détecte automatiquement les actions en attente
dans la boîte mail Gmail de l'utilisateur connecté.

- **Tunnel 1 — En attente stricte** : e-mail envoyé, aucune réponse → relance directe.
- **Tunnel 2 — Tâche non finalisée** : réponse reçue, mais une action reste en attente
  (analyse sémantique par Claude) → relance contextuelle.

Pour chaque détection : contact, objet, date, résumé de la tâche, urgence (HIGH > 14j,
MEDIUM > 7j, NORMAL), et un e-mail de relance pré-rédigé éditable → brouillon Gmail en 1 clic.

Multi-utilisateurs : chaque personne se connecte avec son propre compte Google et ne voit
que ses propres e-mails. Aucune donnée n'est partagée ni stockée en base.

## Stack
Node.js · Express · Google OAuth 2.0 SSO · Gmail API · Claude API (`claude-haiku-4-5-20251001`) ·
Cloudflare Tunnel. Frontend HTML/CSS/JS vanilla, charte graphique « Bleu Citron » (Apple / iOS 18).

## Démarrage rapide (local)

```bash
# 1. Prérequis : Node.js >= 18 (https://nodejs.org)
node --version

# 2. Installer les dépendances
npm install

# 3. Configurer l'environnement
cp .env.example .env
#   puis renseigner GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY, SESSION_SECRET
#   (générer un secret : node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# 4. Lancer
npm start
#   ➜ http://localhost:3000
```

Voir **[SETUP.md](SETUP.md)** pour la configuration complète : Google Cloud, Cloudflare Tunnel,
démarrage automatique launchd sur Mac.

## Architecture

```
[Navigateur] ⇄ HTTPS ⇄ [Cloudflare Tunnel] ⇄ [Express :3000]
  ├── /auth/google     → redirect OAuth Google
  ├── /auth/callback   → tokens → session
  ├── /api/me          → utilisateur connecté
  ├── /api/refresh     → analyse Gmail + Claude (cache 5 min/user)
  ├── /api/draft       → brouillon Gmail
  └── /                → dashboard SPA
         ⇩                      ⇩
   [Gmail API]          [Claude API]
```
