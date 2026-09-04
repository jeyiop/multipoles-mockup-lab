# Multi-Pôles — Site Alpha v0.1 & banque d'objets 3D

Version Alpha du nouveau site multi-poles.net (page d'accueil interactive).
Ce document explique comment sont fabriqués les objets 3D, comment en créer de nouveaux et comment ils s'intègrent au site et à l'app de devis.

## 1. Contenu de l'Alpha

- `Accueil Multi-Pôles.dc.html` — page d'accueil : héro pliage 3D au scroll, galerie de maquettes 3D interactives, carte des 6 usines, configurateur de devis (onglets Packaging/PLV, carrousel de pictos, curseurs L×l×H, quantité, email).
- `fold-hero.html` — animation du tracé qui se plie en coffret (héro).
- `france-map.html` — carte des implantations.
- `modeles/` — banque de 17 objets 3D autonomes + `three-d-stage.js` (moteur de rendu partagé) + `notice-accordeon.html` (app notice pliage accordéon).
- `archive/Accueil ALPHA v0.1.dc.html` — instantané figé de cette version.

## 2. Anatomie d'un objet 3D

Chaque modèle est UN fichier HTML autonome :
1. Import map three.js 0.184 (unpkg, avec integrity).
2. Bloc `<script type="application/json" id="modele-spec">` — fiche technique (source de vérité des cotes, jamais dérivées du mesh).
3. `<three-d-stage name="slug-sans-accent" background="#…" autorotate>` — le viewer (caméra auto-cadrée, orbite, export OBJ/GLB).
4. `<script type="module">` — géométrie construite avec des constantes en tête (W, D, T, REBORD, PACK…). Changer une capacité ne doit jamais demander de retoucher une position en dur.

## 3. Nomenclature des pièces (critique pour le devis)

Préfixes de mesh :
- `car_` pièce carton structurelle → surface facturable (la somme des `car_*` = développé carton)
- `imp_` zone imprimée, plaque fine → surface d'impression
- `prd_` produit factice → hors devis

Format : `<préfixe>_<zone>_<pièce>[_<côté|index>]` — zones : bac, fond, dos, cloison, fronton, etagere, marche, goulotte, flanc, joue, face, poche, socle, caisson, bandeau, separateur, chevalet, patte, traverse. Modèles traversants : suffixes `_recto` / `_verso`.

## 4. Matériaux (5 max par modèle, noms fixes)

`carton_blanc`, `carton_blanc_tranche`, `impression_blanche`, `<couleur>_<usage>` (ex. vert_officine), `pack_produit`.
Carton blanc recto/verso partout (stock Multipoles) ; kraft sur demande explicite.

## 5. Fiche `#modele-spec` (mm)

Champs clés : `ref` (codification TYPE-IMPLANTATION-SECTEUR-CAPACITÉ, ex. BOX-SOL-PH-45), `famille`, `type`, `secteur`, `matiere`, `cannelure`, `epaisseur_mm`, `hors_tout_mm` (encombrement fini, fronton compris), `corps_mm` (corps porteur seul), `chargement` (facings × rangs × capacité + produit_mm), `impression`.
⚠ Ne jamais lire les cotes dans la bounding box : les plaques `imp_*` la gonflent de 2-3 mm.

## 6. Règles de construction PLV

- Flancs de PLV de sol : retour replié de 15 mm sur chaque tranche verticale (un chant nu ne tient pas et montre la cannelure).
- Jamais de patte d'ancrage de fronton visible : piquage dans les retours épais, ou caisson de tête plein (ancrage + communication).
- Dos et fronton = une seule pièce (prolongement du dos). Pas de fronton flottant.
- Pas de béquille sauf besoin réel de stabilité (alors chevalet double replié collé au dos, invisible de face).
- Pas d'ombres portées (elles se lisent comme des pièces fantômes).
- Toujours 2 versions : imprimée + BLANC (même géométrie, matériau carton_blanc_maquette).

## 7. Intégration au site

- Les modèles s'affichent en iframe. Quand ils sont embarqués (iframe), un script `__embed_fit__` ajoute la classe `embedded` qui masque légendes, titres et boutons d'export — plein écran, tout reste visible.
- Le configurateur de devis (section #devis) liste les modèles dans `templatesData` (logic class du DC) : id, label, src, cotes L/l/H. Ajouter un modèle = ajouter le fichier dans `modeles/` + une entrée dans `templatesData` avec son picto SVG.
- Les curseurs de dimensions sont bornés à [40 %, 200 %] de la cote de référence du modèle.

## 8. Fabrication réelle (du 3D à l'atelier)

1. Le client choisit un modèle + cotes dans le configurateur → demande transmise au bureau d'études.
2. Le BE dérive le tracé de découpe (dieline) des constantes du modèle — les `car_*` donnent le développé.
3. Prototypage table de découpe, validation volume/BAT, puis production (impression → découpe/rainage → collage/piquage).
4. Certifications visées : FSC, PEFC, Imprim'Vert, ISO 15378, BPF (étuis pharma).

## 9. Déploiement / travail à plusieurs (à faire)

- GitHub privé : connecter le compte GitHub (bouton dans le chat) puis créer le repo `multipoles-site`.
- Hébergement Hostinger VPS : servir le dossier en statique (nginx, racine = ce dossier, aucun build requis — tout est HTML/JS statique). HTTPS via certbot. Sous-domaine conseillé : alpha.multi-poles.net.
- Reprise du travail : ce dossier est autoporteur ; ouvrir `Accueil Multi-Pôles.dc.html` (nécessite `support.js` à la racine).
