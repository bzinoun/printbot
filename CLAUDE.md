# PrintBot — contexte pour Claude Code

Bot WhatsApp de démo : **un vocal → Claude conçoit un objet 3D → aperçu → « oui » → la Bambu Lab
imprime**, avec photos de suivi. Démo prévue aux **Assises de l'AUSIM** (message : « faire sortir
l'IA de l'ordinateur »). Ce fichier résume les décisions prises pendant la conception.

## Situation réelle de la démo

- L'utilisateur est à **Rabat**, l'imprimante **A1 mini est à Casablanca**, connectée au **cloud
  Bambu**. Pas de réseau local commun → pas de MQTT ni de caméra locale (port 6000).
- L'impression passe par **le plugin Claude Code Bambu de l'utilisateur** (cloud). PrintBot ne
  parle pas à l'imprimante : il demande à `claude -p` d'utiliser ce plugin.
- La « caméra » = **capture de la fenêtre Bambu Studio** ouverte sur le Mac (onglet Appareil,
  vue caméra) via `osascript` (CoreGraphics) + `screencapture -l` + `sips`.
- Le suivi est **calé sur le temps** (état réel illisible à distance) : photo « ça imprime » après
  `PRINT_PREP_MINUTES` + 1, photo finale à la fin estimée.
- **Personne ne vide le plateau** à Casablanca : une 2e impression exige un « oui » de plus.
- Brique WhatsApp reprise du bot de négociation d'**AthenIA** (`bzinoun/athenia`,
  `apps/negotiation-bot`) : Evolution API (Baileys), Groq Whisper, ElevenLabs.

## Carte du code

| Fichier | Rôle |
|---|---|
| `src/bot.ts` | Machine à états par numéro (idle → conception → attente « oui » → impression), commandes |
| `src/intent.ts` | « oui » / « non » / modification ; `/photo`, « montre-moi l'imprimante » |
| `src/claude.ts` | `claude -p --output-format json`, `--resume`, outils d'impression interdits en conception |
| `prompts/designer.md` | Consignes données à Claude (OpenSCAD, A1 mini 180 mm, fichiers `out/`) |
| `src/job.ts` | Dossier par objet dans `jobs/`, `job.json`, `print.json`, aperçu de secours OpenSCAD |
| `src/media.ts` | Conversion JPEG (sharp) : images **affichées** dans WhatsApp, pas en fichier |
| `src/printer/camera.ts` | Capture de la fenêtre Bambu Studio (macOS) |
| `src/printer/monitor.ts` | Photos de suivi + vocal de fin |
| `src/providers/` | Evolution (WhatsApp), Groq (STT), ElevenLabs (TTS) |
| `start.sh` | Lance tout : vérifications, Docker/Evolution, instance, caméra, bot (`caffeinate`) |
| `test/integration/` | Démo jouée de bout en bout avec faux services stricts (`test/fakes/`) |

## Règles à respecter

- **Jamais d'impression avant un « oui » net** : `classifyReply` ne confirme que si *tous* les mots
  sont des acquiescements connus ; en cas de doute → modification.
- **Images** : toujours `sendMedia` + `mediatype: image` + JPEG (via `toWhatsAppJpeg`).
  **Audio** : toujours `sendWhatsAppAudio` (note vocale OGG/Opus). Jamais de `document`.
- Le bot doit **toujours répondre** quelque chose (filet `try/catch` dans `handleIncoming`) et
  être **libéré avant la note vocale** (sinon un « oui » rapide est refusé).
- Avant chaque commit : `npm run check` (types + 388 tests + parcours simulé) doit être vert.

## Reste à faire avant la démo

1. Tester que **le plugin Bambu imprime en headless** (commande dans le README), puis renseigner
   `CLAUDE_PRINT_TOOLS` (nom exact de l'outil d'impression) et `CLAUDE_PLUGIN_DIR` si besoin.
2. `npm run snapshot` avec Bambu Studio ouvert ; autoriser « Enregistrement de l'écran » au terminal.
   Vérifier si l'app est Bambu Studio ou Bambu Handy (`CAMERA_APP`).
3. `.env` : numéro autorisé, clés Groq / ElevenLabs (celles d'AthenIA), **numéro WhatsApp dédié** au bot.
4. À Casablanca : A1 mini allumée, **plateau vide**, filament chargé.
5. Répétition complète avec `./start.sh --check`, puis une vraie impression.
