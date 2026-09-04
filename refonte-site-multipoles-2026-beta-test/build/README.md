# Site Multi-Pôles — build statique

Compile les maquettes Claude Design (`project/*.dc.html`) en pages HTML autonomes,
une par direction couleur, déposables sur n'importe quel hébergement statique.

## Fabriquer

```bash
python3 build/build.py cdn     # → build/out/ (pages) + build/dist/ (site complet)
python3 build/build.py local   # → build/out-local/, three.js/React servis en local
```

`dist/` est le site : `index.html` (la planche de comparaison) plus les six pages.
Aucun serveur, aucune base, aucun build front — que des fichiers.

## Déposer chez un hébergeur

Le contenu de `build/dist/` va tel quel à la racine du dossier public
(`public_html` chez Hostinger, `/var/www/html` sur un VPS nginx). Rien à configurer :
`index.html` est la page d'entrée. Le HTTPS et un `gzip on;` suffisent — les pages
font ~700 Ko chacune et descendent autour de 150 Ko compressées.

## Ce que fait le build

Les maquettes ne sont pas des pages autonomes : elles s'appuient sur le runtime
Claude Design, sur un composant `<image-slot>`, et tirent une vingtaine de documents
satellites (héro 3D, 17 modèles PLV/packaging, carte de France) par `<iframe src>`.
Le build replie tout ça dans un seul fichier :

- `support.js` et `image-slot.js` sont inlinés ; les URL CDN du runtime passent par
  son propre point d'entrée `window.__resources` au lieu d'être réécrites à la main ;
- chaque document satellite entre dans un système de fichiers virtuel en JS, et les
  iframes basculent de `src` vers `srcdoc` au moment de l'affichage — d'où le passage
  de `src` à `data-src` dans le gabarit, pour que le DOM brut n'aille pas chercher
  des fichiers qui n'existent plus ;
- `three.js`, `d3` et React viennent de jsDeliver (unpkg est refusé par la CSP de
  l'hébergement de pages Claude) ; les empreintes SRI, devenues sans objet, sautent ;
- la carte de France ne peut plus aller chercher le world-atlas en `fetch()` : la
  géométrie métropolitaine est figée dans `france-metro.json` au moment du build ;
- le panneau **Réglages** en bas à droite rouvre les props du panneau Tweaks de
  l'éditeur (modèle du héro, couleur du coffret, grille, hauteur des cadres), qui
  n'existeraient pas autrement sur une page publiée.

## Vérification

`build/build.py local` sert three.js et React depuis `vendor/`, ce qui permet
d'exercer les pages hors ligne dans un Chromium sans réseau. Les six pages ont été
passées ainsi : héro qui se plie au défilement, quatre figures animées, carte, et
configurateur de devis chargeant les 16 modèles.

## Limite connue

`Accueil Multi-Pôles - Industry.dc.html` est un instantané antérieur à la galerie de
16 modèles : sa page ne porte que 2 maquettes 3D là où les cinq autres en ont 7.
C'est l'état du fichier source, pas un défaut du build.
