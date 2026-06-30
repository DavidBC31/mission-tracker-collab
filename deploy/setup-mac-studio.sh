#!/usr/bin/env bash
#
# Script d'installation — Suivi Mission Collaborateur sur le Mac Studio (serveur 24/7).
# Automatise : Homebrew, Node, cloudflared, clone du repo, npm install,
# génération des services launchd. Les étapes interactives (login Cloudflare,
# saisie des secrets) sont signalées et à faire manuellement.
#
# Usage :
#   chmod +x setup-mac-studio.sh
#   ./setup-mac-studio.sh
#
# Variables configurables (via env ou édition ci-dessous) :
#   INSTALL_DIR  : où installer le projet           (défaut ~/Apps/suivi-mission)
#   REPO_URL     : URL du dépôt git
#   TUNNEL_NAME  : nom du tunnel Cloudflare          (défaut suivi-mission)
#   DOMAIN       : hostname public (ex: suivi-mission.exemple.com) — REQUIS pour le DNS
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/Apps/suivi-mission}"
REPO_URL="${REPO_URL:-https://github.com/DavidBC31/mission-tracker-collab.git}"
TUNNEL_NAME="${TUNNEL_NAME:-suivi-mission}"
DOMAIN="${DOMAIN:-}"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m⚠\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m➜ %s\033[0m\n" "$1"; }

# --- 1. Homebrew ---------------------------------------------------------
step "1/7 — Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew absent — installation…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Charger brew dans le PATH (Apple Silicon)
  eval "$(/opt/homebrew/bin/brew shellenv)"
else
  ok "Homebrew présent : $(brew --version | head -1)"
fi
# S'assurer que brew est dans le PATH pour la suite
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi

# --- 2. Node + cloudflared ----------------------------------------------
step "2/7 — Node.js & cloudflared"
command -v node >/dev/null 2>&1 || brew install node
command -v cloudflared >/dev/null 2>&1 || brew install cloudflared
ok "node $(node --version), npm $(npm --version)"
ok "cloudflared $(cloudflared --version 2>/dev/null | head -1)"
NODE_BIN="$(command -v node)"
CLOUDFLARED_BIN="$(command -v cloudflared)"

# --- 3. Clone / mise à jour du repo -------------------------------------
step "3/7 — Récupération du code"
if [ -d "$INSTALL_DIR/.git" ]; then
  ok "Dépôt déjà présent — git pull"
  git -C "$INSTALL_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloné dans $INSTALL_DIR"
fi

# --- 4. Dépendances npm --------------------------------------------------
step "4/7 — npm install"
( cd "$INSTALL_DIR" && npm install --omit=dev )
ok "Dépendances installées"

# --- 5. Fichier .env -----------------------------------------------------
step "5/7 — Variables d'environnement"
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  # Génère un SESSION_SECRET automatiquement
  SECRET="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  /usr/bin/sed -i '' "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" "$INSTALL_DIR/.env"
  /usr/bin/sed -i '' "s|^NODE_ENV=.*|NODE_ENV=production|" "$INSTALL_DIR/.env"
  if [ -n "$DOMAIN" ]; then
    /usr/bin/sed -i '' "s|^GOOGLE_REDIRECT_URI=.*|GOOGLE_REDIRECT_URI=https://$DOMAIN/auth/callback|" "$INSTALL_DIR/.env"
  fi
  warn "ACTION REQUISE : éditer $INSTALL_DIR/.env"
  warn "  → renseigner GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY"
  warn "  (SESSION_SECRET et NODE_ENV=production déjà remplis)"
else
  ok ".env déjà présent (laissé tel quel)"
fi

# --- 6. Génération des services launchd ---------------------------------
step "6/7 — Services launchd (démarrage auto + relance)"
LA_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LA_DIR"
BREW_BIN_DIR="$(dirname "$NODE_BIN")"

cat > "$LA_DIR/com.suivi-mission.server.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.suivi-mission.server</string>
    <key>ProgramArguments</key>
    <array><string>$NODE_BIN</string><string>server.js</string></array>
    <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key><string>production</string>
      <key>PATH</key><string>$BREW_BIN_DIR:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/suivi-mission.server.log</string>
    <key>StandardErrorPath</key><string>/tmp/suivi-mission.server.err.log</string>
</dict>
</plist>
PLIST

cat > "$LA_DIR/com.suivi-mission.cloudflared.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.suivi-mission.cloudflared</string>
    <key>ProgramArguments</key>
    <array><string>$CLOUDFLARED_BIN</string><string>tunnel</string><string>run</string><string>$TUNNEL_NAME</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/suivi-mission.cloudflared.log</string>
    <key>StandardErrorPath</key><string>/tmp/suivi-mission.cloudflared.err.log</string>
</dict>
</plist>
PLIST
ok "Plists générés avec les bons chemins absolus dans $LA_DIR"

# --- 7. Étapes interactives Cloudflare (à faire à la main) ---------------
step "7/7 — Cloudflare Tunnel (étapes interactives)"
cat <<INSTRUCTIONS

  Le tunnel nécessite un domaine géré dans Cloudflare. Exécute, dans l'ordre :

    cloudflared tunnel login                       # ouvre le navigateur, autorise ton domaine
    cloudflared tunnel create $TUNNEL_NAME

  Récupère le TUNNEL_ID affiché, puis crée ~/.cloudflared/config.yml :

    tunnel: $TUNNEL_NAME
    credentials-file: $HOME/.cloudflared/<TUNNEL_ID>.json
    ingress:
      - hostname: ${DOMAIN:-suivi-mission.VOTRE-DOMAINE.com}
        service: http://localhost:3000
      - service: http_status:404

  Puis route le DNS :

    cloudflared tunnel route dns $TUNNEL_NAME ${DOMAIN:-suivi-mission.VOTRE-DOMAINE.com}

  ⚠ AVANT de démarrer : dans Google Cloud Console, ajoute l'URI de redirection
     https://${DOMAIN:-VOTRE-DOMAINE}/auth/callback  aux "Authorized redirect URIs",
     et vérifie GOOGLE_REDIRECT_URI dans $INSTALL_DIR/.env.

  Enfin, démarre les deux services (et au boot automatiquement) :

    launchctl load $LA_DIR/com.suivi-mission.server.plist
    launchctl load $LA_DIR/com.suivi-mission.cloudflared.plist

  Vérifs :
    curl -s localhost:3000/api/me        # doit répondre (401 = OK, serveur up)
    tail -f /tmp/suivi-mission.*.log

INSTRUCTIONS

bold "Installation déterministe terminée. Complète les étapes Cloudflare ci-dessus."
