#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#  PrintBot — lance tout d'une commande (macOS)
#
#    ./start.sh           vérifie, démarre WhatsApp (Docker) puis le bot
#    ./start.sh --check   idem, en lançant d'abord tous les tests
#    ./start.sh stop      arrête la passerelle WhatsApp
#    ./start.sh status    état de WhatsApp, du bot et de la caméra
# ──────────────────────────────────────────────────────────────────────────────
# shellcheck disable=SC1112  # apostrophes typographiques voulues dans les messages
set -euo pipefail
cd "$(dirname "$0")"

# ── Affichage ─────────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B='' G='' Y='' R='' D='' N=''; fi
step() { printf '\n%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail() { printf '  %s✗ %s%s\n' "$R" "$1" "$N"; [[ -n "${2:-}" ]] && printf '    %s%s%s\n' "$D" "$2" "$N"; exit 1; }

# ── Lecture du .env (sans « source » : les valeurs peuvent contenir des espaces) ──
env_get() {
  local value
  value=$(grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  printf '%s' "${value:-${2:-}}"
}

wait_for() { # wait_for <secondes> <commande…>
  local timeout=$1; shift
  for ((i = 0; i < timeout; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

evolution_up() { curl -fs -m 3 "$EVO_URL/" -o /dev/null; }

whatsapp_state() {
  curl -fsS -m 5 -H "apikey: $EVO_KEY" "$EVO_URL/instance/connectionState/$EVO_INSTANCE" 2>/dev/null \
    | sed -nE 's/.*"state":"([a-z]+)".*/\1/p' | head -n 1
}

load_settings() {
  PORT=$(env_get PORT 4100)
  EVO_URL=$(env_get EVOLUTION_API_URL http://localhost:8085)
  EVO_KEY=$(env_get EVOLUTION_API_KEY)
  EVO_INSTANCE=$(env_get EVOLUTION_INSTANCE printbot)
}

# ── Sous-commandes ────────────────────────────────────────────
case "${1:-}" in
  stop)
    step "Arrêt de la passerelle WhatsApp"
    docker compose stop && ok "Evolution API arrêtée (la session WhatsApp est conservée)"
    exit 0 ;;
  status)
    [[ -f .env ]] || fail ".env introuvable"
    load_settings
    step "État"
    if evolution_up; then ok "Evolution API : $EVO_URL"; else warn "Evolution API arrêtée (./start.sh)"; fi
    state=$(whatsapp_state || true); [[ "$state" == open ]] && ok "WhatsApp connecté" || warn "WhatsApp : ${state:-inconnu}"
    if curl -fs -m 3 "http://localhost:$PORT/health" -o /dev/null; then ok "Bot actif sur :$PORT"; else warn "Bot arrêté"; fi
    npm run --silent snapshot || true
    exit 0 ;;
  ""|--check) ;;
  *) echo "Usage : ./start.sh [--check | stop | status]"; exit 1 ;;
esac

printf '%s🖨️  PrintBot%s — un vocal WhatsApp, un objet imprimé\n' "$B" "$N"

# ── 1. Configuration ──────────────────────────────────────────
step "Configuration"
if [[ ! -f .env ]]; then
  cp .env.example .env
  fail "Fichier .env créé à partir de .env.example : remplis-le puis relance ./start.sh" \
       "Au minimum : ALLOWED_NUMBERS (ton numéro) et GROQ_API_KEY (vocaux)"
fi
load_settings
[[ -n "$EVO_KEY" ]] || fail "EVOLUTION_API_KEY est vide dans .env"
numbers=$(env_get ALLOWED_NUMBERS)
[[ -n "$numbers" ]] && ok "Numéros autorisés : $numbers" || fail "ALLOWED_NUMBERS est vide dans .env" "Mets ton numéro, ex. 212612345678"
webhook=$(env_get WEBHOOK_PUBLIC_URL "http://host.docker.internal:$PORT/webhook")
[[ "$webhook" == *":$PORT/"* ]] || warn "WEBHOOK_PUBLIC_URL ($webhook) ne vise pas le port du bot ($PORT) : les messages n'arriveront pas"
[[ -n "$(env_get GROQ_API_KEY)" ]] && ok "Transcription des vocaux (Groq)" || warn "GROQ_API_KEY vide : les vocaux ne seront pas compris"
[[ -n "$(env_get ELEVENLABS_API_KEY)" && -n "$(env_get ELEVENLABS_VOICE_ID)" ]] && ok "Réponses vocales (ElevenLabs)" || warn "Pas de réponses vocales (ElevenLabs non configuré)"

# ── 2. Outils ─────────────────────────────────────────────────
step "Outils"
command -v node >/dev/null || fail "Node.js introuvable" "brew install node"
node_major=$(node -p 'process.versions.node.split(".")[0]')
(( node_major >= 20 )) || fail "Node.js $node_major trop ancien (20 minimum)" "brew upgrade node"
ok "Node.js $(node -v)"

claude_bin=$(env_get CLAUDE_BIN claude)
command -v "$claude_bin" >/dev/null || fail "Claude Code introuvable ($claude_bin)" "npm install -g @anthropic-ai/claude-code puis claude login"
ok "Claude Code $("$claude_bin" --version 2>/dev/null | head -n 1)"

# OpenSCAD : si le chemin du .env ne marche pas, on prend celui de l'app (l'environnement prime sur .env)
openscad_bin=$(env_get OPENSCAD_BIN openscad)
mac_openscad=/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD
if command -v "$openscad_bin" >/dev/null 2>&1; then
  ok "OpenSCAD"
elif [[ -x "$mac_openscad" ]]; then
  export OPENSCAD_BIN="$mac_openscad"
  ok "OpenSCAD (app trouvée : $mac_openscad)"
else
  fail "OpenSCAD introuvable — nécessaire pour les aperçus" "brew install --cask openscad"
fi

if [[ ! -d node_modules || package-lock.json -nt node_modules ]]; then
  echo "  … installation des dépendances"
  npm install --no-audit --no-fund --loglevel=error
fi
ok "Dépendances"

# ── 3. Tests (option) ─────────────────────────────────────────
if [[ "${1:-}" == --check ]]; then
  step "Tests"
  npm run --silent check || fail "Des tests échouent : ne pas lancer la démo avant correction"
  ok "Tous les tests passent"
fi

# ── 4. Passerelle WhatsApp (Docker) ───────────────────────────
step "Passerelle WhatsApp"
command -v docker >/dev/null || fail "Docker introuvable" "brew install --cask docker"
if ! docker info >/dev/null 2>&1; then
  echo "  … démarrage de Docker Desktop"
  open -a Docker 2>/dev/null || true
  wait_for 90 docker info || fail "Docker ne démarre pas" "Ouvre Docker Desktop à la main puis relance"
fi
ok "Docker"
docker compose up -d --quiet-pull >/dev/null 2>&1 || docker compose up -d
wait_for 90 evolution_up || fail "Evolution API ne répond pas sur $EVO_URL" "docker compose logs evolution-api"
ok "Evolution API : $EVO_URL"
npm run --silent setup | sed 's/^/  /'

# ── 5. Caméra (fenêtre Bambu sur ce Mac) ──────────────────────
step "Caméra"
if [[ "$(env_get CAMERA_MODE window)" == off ]]; then
  warn "Désactivée (CAMERA_MODE=off)"
elif npm run --silent snapshot >/tmp/printbot-snapshot.log 2>&1; then
  ok "$(grep -E 'Fenêtre trouvée|Capture enregistrée' /tmp/printbot-snapshot.log | head -n 1 | sed 's/^✅ //')"
  printf '    %sVérifie snapshot.jpg : si tu ne vois que le fond d’écran, autorise l’enregistrement de l’écran%s\n' "$D" "$N"
else
  warn "$(grep -E '❌' /tmp/printbot-snapshot.log | head -n 1 | sed 's/^❌ //')"
  printf '    %sLe bot démarre quand même ; les suivis partiront sans photo%s\n' "$D" "$N"
fi

# ── 6. Bot ────────────────────────────────────────────────────
step "Bot"
if curl -fs -m 2 "http://localhost:$PORT/health" -o /dev/null; then
  fail "Un bot tourne déjà sur le port $PORT" "Arrête-le (Ctrl+C dans son terminal) ou change PORT dans .env"
fi

state=$(whatsapp_state || true)
if [[ "$state" == open ]]; then
  ok "WhatsApp connecté"
else
  warn "WhatsApp non connecté : la page du QR code va s’ouvrir"
  printf '    %sWhatsApp › Appareils connectés › Connecter un appareil (avec le téléphone du bot)%s\n' "$D" "$N"
  if command -v open >/dev/null; then
    (wait_for 30 curl -fsS -m 2 "http://localhost:$PORT/health" -o /dev/null && open "http://localhost:$PORT/qr" >/dev/null 2>&1) &
  else
    printf '    %sOuvre http://localhost:%s/qr%s\n' "$D" "$PORT" "$N"
  fi
fi

printf '\n%s🚀 PrintBot démarre%s — Ctrl+C pour arrêter · le Mac ne se mettra pas en veille\n\n' "$G" "$N"
# caffeinate : pas de veille du Mac (ni de l'écran) tant que le bot tourne
if command -v caffeinate >/dev/null; then exec caffeinate -dims npm start; else exec npm start; fi
