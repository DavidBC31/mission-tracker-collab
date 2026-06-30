# Runbook — Déploiement sur le Mac Studio (serveur 24/7)

Objectif : faire tourner l'app en permanence sur le Mac Studio, exposée publiquement
en HTTPS via **Cloudflare Tunnel**. À exécuter **sur le Mac Studio** (pas sur un portable).

## Pré-requis à avoir sous la main
- Un **domaine géré dans Cloudflare** (ex: `bleucitron.net`). Indispensable pour une URL stable.
  → l'app sera sur un sous-domaine, ex. `suivi-mission.bleucitron.net`.
- Les **secrets** : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Google Cloud), `ANTHROPIC_API_KEY`.
- Accès au **Google Cloud Console** pour ajouter l'URI de redirection de prod.

---

## Étape A — Lancer le script d'installation

Sur le Mac Studio, ouvrir le Terminal :

```bash
# Récupérer juste le script (ou cloner tout le repo)
curl -fsSL https://raw.githubusercontent.com/DavidBC31/mission-tracker-collab/main/deploy/setup-mac-studio.sh -o setup-mac-studio.sh
chmod +x setup-mac-studio.sh

# Lancer en précisant ton domaine public
DOMAIN="suivi-mission.bleucitron.net" ./setup-mac-studio.sh
```

Le script installe Homebrew/Node/cloudflared, clone le repo dans `~/Apps/suivi-mission`,
fait `npm install`, génère un `.env` (avec `SESSION_SECRET` + `NODE_ENV=production` déjà
remplis) et crée les deux services launchd avec les bons chemins.

## Étape B — Renseigner les secrets

```bash
nano ~/Apps/suivi-mission/.env
```
Compléter `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY`.
(Vérifier que `GOOGLE_REDIRECT_URI=https://suivi-mission.bleucitron.net/auth/callback`.)

## Étape C — Cloudflare Tunnel

```bash
cloudflared tunnel login                    # ouvre le navigateur → autoriser le domaine
cloudflared tunnel create suivi-mission     # note le TUNNEL_ID affiché
```

Créer `~/.cloudflared/config.yml` :
```yaml
tunnel: suivi-mission
credentials-file: /Users/<USER>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: suivi-mission.bleucitron.net
    service: http://localhost:3000
  - service: http_status:404
```

Router le DNS :
```bash
cloudflared tunnel route dns suivi-mission suivi-mission.bleucitron.net
```

## Étape D — Google Cloud (URI de prod)

Dans Google Cloud Console → Credentials → ton OAuth client → **Authorized redirect URIs**,
ajouter :
```
https://suivi-mission.bleucitron.net/auth/callback
```
(En mode *Testing* de l'écran de consentement, ajouter aussi les e-mails dans **Test users**.)

## Étape E — Démarrer (et activer le démarrage auto)

```bash
launchctl load ~/Library/LaunchAgents/com.suivi-mission.server.plist
launchctl load ~/Library/LaunchAgents/com.suivi-mission.cloudflared.plist
```

Vérifications :
```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/me   # 401 attendu = serveur up
tail -f /tmp/suivi-mission.*.log
```
Puis ouvrir **https://suivi-mission.bleucitron.net** depuis n'importe où → écran de connexion Google.

---

## Mises à jour ultérieures du code
```bash
cd ~/Apps/suivi-mission && git pull && npm install --omit=dev
launchctl kickstart -k gui/$(id -u)/com.suivi-mission.server
```

## Arrêt
```bash
launchctl unload ~/Library/LaunchAgents/com.suivi-mission.server.plist
launchctl unload ~/Library/LaunchAgents/com.suivi-mission.cloudflared.plist
```

## Dépannage
- **502 / page blanche** : le serveur Node n'est pas up → `tail /tmp/suivi-mission.server.err.log`.
- **redirect_uri_mismatch** : l'URI dans Google Cloud ≠ `GOOGLE_REDIRECT_URI` du `.env`.
- **Déconnexions fréquentes** : sessions en mémoire — un redémarrage du service vide les sessions
  (les utilisateurs se reconnectent via Google, sans gravité).
- **cloudflared ne démarre pas** : vérifier le chemin du `credentials-file` dans `config.yml`.
