# 📋 Suivi Mission Collaborateur

Tableau de bord d'analyse d'e-mails qui détecte automatiquement les actions en attente
dans la boîte mail Gmail de l'utilisateur connecté.

- **Tunnel 1 — En attente stricte** : e-mail envoyé, aucune réponse → relance directe.
- **Tunnel 2 — Tâche non finalisée** : réponse reçue, mais une action reste en attente
  (analyse sémantique par Claude) → relance contextuelle.

Pour chaque détection : contact, objet, jours sans réponse, résumé de la tâche, urgence,
corps du mail, et une relance pré-rédigée (registre tu/vous détecté automatiquement) —
reformulable en 1 clic, envoyable directement ou en brouillon Gmail.

Fonctionnalités clés :
- **Fiabilité** : classification Claude des deux tunnels sur le corps des fils, filtres
  anti-bruit (noreply, newsletters, invitations calendrier)
- **Statuts** : traité / ignoré / reporté 7 j — un fil classé ne revient plus (sauf nouveau message)
- **Digest matinal** : récap quotidien des relances par e-mail (opt-out 🔔)
- **Rapide** : cache d'analyse par fil (fils inchangés = zéro appel IA), analyse parallélisée,
  résultats affichés au fil de l'eau (SSE) sans bloquer l'écran
- **Sécurisé** : SSO restreint au domaine de l'entreprise, tokens chiffrés
- **UI** : recherche, filtre urgents, tri par priorité, dark mode, accessible au clavier

Multi-utilisateurs : chaque personne se connecte avec son propre compte Google et ne voit
que ses propres e-mails. Pas de base de données : un fichier JSON par utilisateur dans `data/`
(tokens chiffrés AES-256-GCM, statuts, cache d'analyse).

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
