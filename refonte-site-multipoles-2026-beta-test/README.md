# Site Multi-Pôles — six directions couleur

La nouvelle page d'accueil de multi-poles.net, dans ses six habillages. Même contenu,
mêmes maquettes 3D, même configurateur de devis dans chacun : seules changent les
couleurs et les polices.

`index.html` est la planche de comparaison ; les six pages sont à côté.

| Réf. | Direction | Fichier |
|------|-----------|---------|
| V2D | Bleu Nuit — *la plus aboutie* | `bleu-nuit.html` |
| ORIG | Papier / Bordeaux — *le modèle d'origine* | `papier-bordeaux.html` |
| V2A | Papier — *éditorial luxe* | `v2a-papier.html` |
| V2B | Charbon — *showroom sombre* | `v2b-charbon.html` |
| V2C | Blueprint — *technique acier* | `v2c-blueprint.html` |
| IND | Industry / Acier — *bureau d'études* | `industry-acier.html` |

## Mettre en ligne

Le site est **entièrement statique** : sept fichiers HTML, aucun serveur, aucune base,
aucune étape de compilation côté hébergeur. Tout ce dont il a besoin — le moteur 3D,
les 17 maquettes, la carte — est déjà dans les fichiers ou tiré d'un CDN public.

### Hostinger — déploiement Git

Dans hPanel → *Sites web* → ton site → **Déploiement Git** : ajoute ce dépôt, branche
`main`, et laisse le répertoire de destination vide (la racine du dépôt va dans
`public_html`). Chaque mise à jour se déploie ensuite d'un clic sur *Déployer*.

Si Hostinger ne voit pas un dépôt privé, ajoute-lui la clé de déploiement qu'il te
propose dans les *Paramètres → Clés de déploiement* du dépôt GitHub.

### Hostinger — dépôt manuel

À défaut, glisse les sept `.html` (plus `.nojekyll`) directement dans `public_html`,
**à la racine, pas dans un sous-dossier** — sinon l'adresse devient `ton-site.fr/dist/`
au lieu de `ton-site.fr/`. Si un `index.html` d'accueil Hostinger s'y trouve déjà,
remplace-le.

### GitHub Pages

*Settings → Pages → Source : Deploy from a branch → `main` / `(root)`*. Le site sort
alors sur **https://jeyiop.github.io/multipoles-mockup-lab/refonte-site-multipoles-2026-beta-test/**, sans toucher au
prototype PLV qui reste à la racine du dépôt.

Le fichier `.nojekyll` est là pour ça : sans lui, Pages passe le dépôt dans Jekyll, qui
ignore les dossiers commençant par un souligné (`project/_ds/`).

⚠️ Ce dépôt est **public** : tout ce qui y entre est lisible par n'importe qui.

### VPS nginx

Le contenu de la racine va dans `/var/www/html`. Un `gzip on;` vaut le détour : les
pages font environ 700 Ko et tombent autour de 150 Ko compressées.

## Refabriquer les pages

Les fichiers HTML de la racine sont **générés** — ne les éditez pas à la main. La source
est dans `project/` (les maquettes Claude Design et leurs satellites 3D) :

```bash
python3 build/build.py cdn
```

`build/README.md` détaille ce que fait la compilation et pourquoi.

## Ce qui attend encore de vous

- Les six villes d'implantation et leurs spécialités sont illustratives.
- Les certifications (FSC, PEFC, Imprim'Vert, ISO 15378, BPF) attendent les vrais logos.
- La galerie attend les prises de vue studio.
- Les cotes des coffrets packaging sont indicatives.
