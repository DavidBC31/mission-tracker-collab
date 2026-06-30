# Guide de configuration complet

## 0. Prérequis

Installer **Node.js >= 18** (non installé sur cette machine actuellement) :

```bash
# Option A — via le site officiel
#   https://nodejs.org  (LTS)

# Option B — via Homebrew (si Homebrew est installé)
brew install node

# Vérifier
node --version && npm --version
```

Puis, à la racine du projet :

```bash
npm install
cp .env.example .env
```

---

## 1. Google Cloud Console (OAuth + Gmail API)

1. Aller sur https://console.cloud.google.com → créer/sélectionner un projet.
2. **APIs & Services → Library** → activer **Gmail API**.
3. **APIs & Services → OAuth consent screen** :
   - Type : *External* (ou *Internal* si Google Workspace).
   - Ajouter les scopes :
     - `.../auth/gmail.readonly`
     - `.../auth/gmail.compose`
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
   - En mode *Testing*, ajouter les e-mails autorisés dans **Test users**.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** :
   - Type : **Web application**.
   - **Authorized redirect URIs** :
     - `http://localhost:3000/auth/callback`
     - `https://VOTRE-DOMAINE/auth/callback`
5. Copier le **Client ID** et le **Client secret** dans `.env`.

```env
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback   # ou l'URL de prod
```

---

## 2. Clé API Anthropic (Claude)

1. https://console.anthropic.com → **API Keys** → créer une clé.
2. La placer dans `.env` :

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Le modèle utilisé est `claude-haiku-4-5-20251001` (modifiable dans `config.js`).

---

## 3. Secret de session

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

```env
SESSION_SECRET=<la chaîne générée>
```

---

## 4. Test en local

```bash
npm start
# ➜ http://localhost:3000  →  « Se connecter avec Google »
```

---

## 5. Cloudflare Tunnel (exposition HTTPS publique)

```bash
brew install cloudflare/cloudflare/cloudflared

cloudflared tunnel login
cloudflared tunnel create suivi-mission
```

Créer `~/.cloudflared/config.yml` :

```yaml
tunnel: suivi-mission
credentials-file: /Users/VOTRE_USER/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: suivi-mission.VOTRE-DOMAINE.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel route dns suivi-mission suivi-mission.VOTRE-DOMAINE.com
cloudflared tunnel run suivi-mission   # test manuel
```

⚠ En prod, mettre `NODE_ENV=production` dans `.env` et la bonne `GOOGLE_REDIRECT_URI`
(`https://suivi-mission.VOTRE-DOMAINE.com/auth/callback`), puis ajouter cette URI dans
les *Authorized redirect URIs* de Google Cloud.

### (Optionnel) Cloudflare Access — Zero Trust
Pour restreindre l'accès à certains comptes Google, configurer une **Access Application**
sur le hostname du tunnel dans le dashboard Cloudflare Zero Trust.

---

## 6. Démarrage automatique sur Mac (launchd)

Deux fichiers fournis dans `deploy/` — à adapter (chemins absolus) puis copier dans
`~/Library/LaunchAgents/` :

```bash
# Adapter les chemins WORKING_DIR / node dans les .plist, puis :
cp deploy/com.suivi-mission.server.plist ~/Library/LaunchAgents/
cp deploy/com.suivi-mission.cloudflared.plist ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.suivi-mission.server.plist
launchctl load ~/Library/LaunchAgents/com.suivi-mission.cloudflared.plist
```

Les deux services ont `RunAtLoad` et `KeepAlive` activés → relance automatique au
démarrage du Mac et en cas de crash.

Pour arrêter : `launchctl unload ~/Library/LaunchAgents/com.suivi-mission.*.plist`

---

## 7. Sécurité — rappel

- `.env` est dans `.gitignore` : ne jamais committer les secrets.
- Cookies de session : `httpOnly`, `secure` en prod, `sameSite: lax`.
- Aucune donnée persistée (pas de DB) : tokens et résultats vivent en session/mémoire.
- Restreindre l'accès via Cloudflare Access si nécessaire.
