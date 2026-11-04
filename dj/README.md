# Platine DJ

Logiciel DJ dans le navigateur : bibliothèque, analyse, deux decks, mixeur, enregistrement.
Aucune installation, aucun serveur : la musique reste sur votre machine (IndexedDB).

## Lancer

```bash
cd dj
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Un double-clic sur `index.html` marche aussi dans Chrome et Edge. Navigateur conseillé : Chrome ou Edge récent
(Firefox et Safari fonctionnent, avec moins de formats audio pris en charge).

## Fonctions

**Bibliothèque**
- Import de fichiers ou de dossiers entiers (bouton ou glisser-déposer) : MP3, WAV, AIFF, FLAC, M4A, OGG…
- Lecture des tags ID3 (titre, artiste, album, genre), sinon déduits du nom « Artiste - Titre »
- Analyse automatique : **BPM**, **grille rythmique**, **tonalité** (notation Camelot), **waveform 3 bandes**
- Recherche, tri par colonne, playlists (création, renommage, glisser-déposer), historique de session
- Filtre **mix harmonique** : morceaux compatibles (Camelot ±1 / relatif, BPM ±6 %) avec le deck A ou B
- Correction manuelle du BPM (double-clic), export de la tracklist en texte (avec horodatage pour l'historique)

**Decks (×2)**
- Waveform zoomée défilante avec grille (mesures en rouge), vue d'ensemble cliquable, scrub à la souris
- CUE (pose / pré-écoute en maintenant / retour), 8 hot cues mémorisés par morceau
- Boucles auto (1/32 à 64 temps, ½ / ×2), IN / OUT manuels, EXIT / RELOOP — calées à l'échantillon près
- Tempo ±8 / 16 / 50 %, nudge, **master tempo** (keylock : la tonalité ne bouge pas avec le tempo)
- **SYNC** tempo + phase (gère les rapports ×2 / ½), verrouillé tant qu'on ne touche pas au tempo
- Quantize, outils de grille (BPM ½ / ×2, décalage 5 ms, « 1er temps ici »), compteur de temps 1-2-3-4

**Mixeur**
- Par voie : trim, EQ 3 bandes avec kill, filtre LP/HP sur un seul bouton, fader, VU-mètre
- Crossfader 3 courbes (doux, mix, cut), volume master, limiteur, VU master
- **REC** : enregistre le mix et le télécharge en fin d'enregistrement

Raccourcis clavier : bouton `?` dans l'application.

## Architecture

| Fichier | Rôle |
|---|---|
| `js/engine.js` | Moteur audio : lecteur AudioWorklet par deck (tempo variable, boucles exactes, sauts sans clic, time-stretch WSOLA pour le keylock), tranches de mixeur |
| `js/analysis.js` | BPM (autocorrélation + repli de phase), grille, tonalité (chromagramme + profils Krumhansl), waveform |
| `js/waveform.js` | Rendu canvas des waveforms |
| `js/app.js` | Interface, bibliothèque, playlists, raccourcis, enregistrement |
| `js/db.js`, `js/tags.js` | Stockage IndexedDB, lecture ID3 |

## Limites actuelles (pistes pour la suite)

- Pas encore de pré-écoute casque séparée (il faut une carte son multi-sorties), ni de mapping de contrôleur MIDI
- Pas d'export vers clé USB pour platines CDJ, pas d'effets (écho, reverb…), pas de séparation de stems
- Grille à tempo fixe : les morceaux à tempo variable (live, vieux disques) se calent mal
- Les fichiers sont copiés dans le stockage du navigateur : vider les données du site efface la bibliothèque
