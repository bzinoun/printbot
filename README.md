# 🖨️ PrintBot

**Un vocal WhatsApp → Claude conçoit l'objet → aperçu → « oui » → la Bambu Lab imprime.**

Démo « faire sortir l'IA de l'ordinateur » : on parle à son téléphone, un objet réel sort de l'imprimante.
La brique WhatsApp (Evolution API, Whisper, ElevenLabs) est reprise du bot de négociation d'AthenIA.

```
 📱 WhatsApp ──vocal──▶ Evolution API ──webhook──▶ PrintBot (Mac)
                                                     │ Whisper (Groq) : vocal → texte
                                                     │ claude -p  + plugin Bambu
                                                     │   ├─ conception : model.scad → model.stl → preview.png
                                                     │   └─ confirmation : envoi à l'imprimante
 📱 WhatsApp ◀──aperçu + vocal (ElevenLabs)──────────┘
```

## Le dialogue

| Toi | PrintBot |
|---|---|
| 🎤 « Fais-moi un porte-clé avec AUSIM 2026 » | 🎤 _« Fais-moi un porte-clé avec AUSIM 2026 »_ · 🎨 Je conçois… |
| | 📸 aperçu 3D + « 75 × 17 × 4 mm · ~14 min. Réponds *oui* pour imprimer » + 🔊 vocal |
| « Oui mais plus grand » | ✏️ Je modifie… → nouvel aperçu |
| « Vas-y » | 🚀 J'envoie à la Bambu… · ✅ Impression lancée ! Nouvelles dans ~6 min |
| | 📸 « Ça imprime à Casablanca ! » + photo de la vue caméra |
| | 🏁 « Ton objet devrait être prêt ! » + photo + 🔊 vocal |
| 🎤 « Montre-moi l'imprimante » | 📷 photo en direct |
| 📸 photo d'un croquis | conçoit l'objet à partir du dessin |

Réponses comprises : *oui / ok / vas-y / lance / wakha…*, *non / annule / stop…*, et tout le reste est
traité comme une modification. Commandes : `/status`, `/photo`, `/reset`, `/aide`.

## Imprimante à distance (A1 mini à Casablanca)

L'imprimante n'est pas sur le réseau du Mac : l'impression passe par le cloud Bambu (ton plugin),
et la « caméra » est **la fenêtre de l'app Bambu ouverte sur le Mac** (Bambu Studio, onglet
Appareil, vue caméra), que PrintBot photographie avec les outils intégrés à macOS.

```bash
npm run snapshot   # trouve la fenêtre, la photographie, enregistre snapshot.jpg
```

- Autorise une fois **Enregistrement de l'écran** pour ton terminal (Réglages système ›
  Confidentialité et sécurité), sinon la capture ne montre que le fond d'écran.
- La fenêtre peut être derrière une autre, mais **pas réduite** dans le Dock.
- `CAMERA_APP=Bambu Handy` si tu utilises Handy ; `CAMERA_MODE=screen` pour capturer l'écran entier.
- Le suivi se cale sur le temps (l'état réel n'est pas lisible à distance) : photo ~6 min après
  le lancement (`PRINT_PREP_MINUTES` + 1), photo finale à la fin estimée. La photo montre la
  progression réelle affichée par l'app.
- **Plateau** : l'A1 mini n'éjecte pas ses pièces. Après une impression, la suivante exige un
  deuxième « oui » explicite (« le plateau doit être vide »).

## Installation (Mac)

```bash
# Pré-requis (une fois)
brew install node
brew install --cask openscad docker
npm install -g @anthropic-ai/claude-code && claude login

git clone https://github.com/bzinoun/printbot && cd printbot
./start.sh          # 1er lancement : crée .env → remplis-le, puis relance
```

`./start.sh` fait tout, dans l'ordre, et s'arrête avec une explication claire si quelque chose manque :

1. vérifie `.env` (numéros autorisés, clés Groq / ElevenLabs, port du webhook) ;
2. vérifie Node, Claude Code, OpenSCAD (trouve l'app tout seul) et installe les dépendances ;
3. démarre Docker Desktop si besoin, puis la passerelle WhatsApp (Evolution API) et crée l'instance ;
4. teste la caméra (fenêtre Bambu Studio) et enregistre `snapshot.jpg` ;
5. ouvre la page du QR code si WhatsApp n'est pas encore connecté ;
6. lance le bot en empêchant le Mac de se mettre en veille (`caffeinate`).

| Commande | Usage |
|---|---|
| `./start.sh` | Lancer la démo |
| `./start.sh --check` | Lancer tous les tests d'abord (recommandé le jour J) |
| `./start.sh status` | WhatsApp, bot et caméra : tout est-il prêt ? |
| `./start.sh stop` | Arrêter la passerelle WhatsApp (la session est conservée) |

> ⚠️ Utilise un **numéro dédié** pour le bot (WhatsApp n'a pas d'API officielle pour ce type de bot,
> risque de bannissement). Ton numéro perso va dans `ALLOWED_NUMBERS`.

### `.env` — l'essentiel

| Variable | Rôle |
|---|---|
| `ALLOWED_NUMBERS` | Ton numéro (ex. `212612345678`). **Seuls ces numéros pilotent l'imprimante.** |
| `GROQ_API_KEY` | Transcription des vocaux (même clé qu'AthenIA). |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Réponses vocales (optionnel, reprends la voix d'AthenIA). |
| `OPENSCAD_BIN` | `/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD` |
| `CLAUDE_PLUGIN_DIR` | Dossier de ton plugin Bambu, s'il n'est pas installé globalement. |
| `CLAUDE_PRINT_TOOLS` | Nom(s) de l'outil d'impression du plugin : interdit pendant la conception (garde-fou). |
| `CLAUDE_MODEL` | `sonnet` pour aller plus vite sur scène (optionnel). |

## Brancher ton plugin Bambu

PrintBot ne parle pas directement à l'imprimante : il demande à Claude Code d'utiliser **ton plugin**
(cloud Bambu). Avant la démo, vérifie que l'impression marche en headless dans un dossier de job :

```bash
mkdir -p /tmp/t/out && cd /tmp/t
echo 'cube([20,20,2]);' > out/model.scad && openscad -o out/model.stl out/model.scad
echo "Imprime out/model.stl sur la Bambu avec le plugin" | claude -p --permission-mode bypassPermissions
```

Si ça imprime, PrintBot imprimera. Les consignes données à Claude (formats, règles d'imprimabilité,
fichiers attendus) sont dans [`prompts/designer.md`](prompts/designer.md) : adapte la section
« Phase IMPRESSION » si ton plugin attend un 3MF ou une étape de découpe.

## Comment ça marche

- **`src/whatsapp.ts`** — normalise les webhooks Evolution (texte, vocal, photo, numéros `@lid`).
- **`src/bot.ts`** — machine à états par numéro : `idle → conception → attente de validation → impression`.
  Un seul traitement à la fois, les messages en double sont ignorés.
- **`src/claude.ts`** — `claude -p --output-format json`. Le `session_id` est repris avec `--resume`
  pour les modifications et la confirmation, donc Claude garde tout le contexte du modèle.
  Pendant la conception, les outils listés dans `CLAUDE_PRINT_TOOLS` sont interdits.
- **`src/job.ts`** — un dossier par objet dans `jobs/` (requête, `.scad`, `.stl`, aperçu, `job.json`).
  Si Claude n'a pas produit d'aperçu, PrintBot le rend lui-même avec OpenSCAD.
- **`src/providers/`** — Evolution, Groq Whisper, ElevenLabs (repris d'AthenIA).

## Tests

```bash
npm run check          # types + 360 tests unitaires + parcours complet simulé (à lancer avant la démo)
npm test               # tests unitaires seuls
npm run test:coverage  # couverture (≈ 99 %)
```

Ce que les tests verrouillent :

| Domaine | Garanties |
|---|---|
| **Validation** (`intent`) | Une impression ne part que si **tous** les mots sont des « oui » connus : « ok, fais-le en étoile » ou « imprime un cube » deviennent des modifications. « non », « pas maintenant », « لا » annulent. |
| **Machine à états** (`bot`) | Conception → aperçu → oui/non/modif ; pas de double conception si deux vocaux arrivent en même temps ; « oui » envoyé deux fois = une seule impression ; un ancien `print.json` ne fait jamais croire à un succès ; un aperçu périmé n'est jamais renvoyé. |
| **Pannes** | Claude en erreur, timeout ou absent ; Whisper, ElevenLabs ou WhatsApp en panne ; OpenSCAD absent : le bot répond toujours un message clair et reste utilisable. |
| **Claude** | Prompt passé par stdin (guillemets, `$`, accents), reprise de session, outils d'impression interdits pendant la conception, variables de la session Claude parente retirées. |
| **WhatsApp** | Numéros `@lid`, suffixes d'appareil, groupes/statuts/chaînes ignorés, whitelist, doublons. |
| **Serveur** | Le webhook répond tout de suite même si Claude travaille plusieurs minutes ; une erreur n'arrête jamais le serveur. |
| **Caméra & suivi** | Bonne fenêtre choisie (app, taille, visible), capture JPEG réduite, aucun fichier temporaire laissé ; photos au bon moment (horloge simulée) ; caméra absente ou en panne → message clair ; deuxième impression bloquée tant que le plateau n'est pas confirmé vide. |

## Check-list démo

- [ ] À Casablanca : A1 mini allumée, **plateau vide et propre**, filament chargé, en ligne
- [ ] Bambu Studio ouvert sur le Mac, onglet Appareil, vue caméra visible ; `npm run snapshot` OK
- [ ] `http://localhost:4100/health` → `"whatsapp": "open"`
- [ ] Test complet la veille sur le réseau de la salle (ou partage 4G)
- [ ] Une impression de secours déjà faite, à sortir « comme dans une émission de cuisine »
- [ ] Téléphone recopié sur l'écran pour que la salle voie la conversation
- [ ] Vidéo de la démo complète en plan B
