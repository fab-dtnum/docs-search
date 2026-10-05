# docs-search

Recherche plein texte dans une arborescence [Docs](https://docs.numerique.gouv.fr) (document + sous-documents).

La recherche de Docs ne porte que sur les titres. Cet outil télécharge un document et tous ses sous-documents en Markdown, dans un **instantané daté**, puis y cherche avec [ripgrep](https://github.com/BurntSushi/ripgrep). Chaque instantané s'ouvre aussi comme un coffre **Obsidian**.

## Installation

Prérequis : Node ≥ 22.18 (exécute le TypeScript directement, version de référence dans `.nvmrc`) et ripgrep (`brew install ripgrep` sur macOS, `sudo apt install ripgrep` sur Ubuntu).

```bash
corepack enable                          # active le pnpm épinglé dans package.json
pnpm install
pnpm exec playwright install chromium    # navigateur pour `pnpm run login`
```

pnpm uniquement : npm et yarn sont refusés.

Si `pnpm install` échoue avec `Cannot find module …/pnpm.cjs`, c'est que le corepack livré avec votre Node est trop ancien pour pnpm 12. À partir de Node 25, corepack n'est d'ailleurs plus livré du tout. Dans les deux cas, installez-le à part :

```bash
npm install -g --ignore-scripts corepack@0.36.0 && corepack enable
```

## Connexion

Docs utilise ProConnect : pas de connexion par mot de passe depuis un script. On réutilise le cookie de session `docs_sessionid` du navigateur (valable 12 h par défaut).

```bash
pnpm run login
```

Une fenêtre Chromium s'ouvre et vous vous connectez vous-même. Le cookie est ensuite enregistré dans `.env`. Le profil de navigateur est conservé dans `.auth/`, donc les reconnexions suivantes sont souvent immédiates.

Sinon, vous pouvez recopier le cookie à la main : DevTools → Application → Cookies → `docs_sessionid`, à mettre dans `.env` (voir `.env.example`).

## Utilisation

`<doc>` est l'UUID du document ou son URL complète.

```bash
pnpm run sync <doc>                       # nouvel instantané data/<id>-AAAA-MM-JJ-HHhMM/
pnpm run sync <doc> --force               # sans recopier les documents inchangés
pnpm run search <doc> -i "copil|comité" -C2
pnpm run search <doc> --sync -w budget    # resynchronise avant de chercher
pnpm run list                             # instantanés locaux
```

⚠️ Toujours `pnpm run …` : `pnpm login`, `pnpm list` et `pnpm search` sont des commandes de pnpm lui-même (registre npm), pas celles de ce projet.

- **sync** affiche le nombre de documents récupérés (1 document + N sous-documents) et la date de la dernière modification d'un sous-document. Les documents dont `updated_at` n'a pas changé sont recopiés depuis l'instantané précédent au lieu d'être retéléchargés.
- **search** transmet tous les arguments qui suivent `<doc>` à `rg` (syntaxe ripgrep), puis affiche les liens vers Docs des documents trouvés.
  - Si l'instantané le plus récent ne date pas d'aujourd'hui, le script donne sa date et propose de retélécharger.
  - `--sync` retélécharge sans poser la question, `--no-sync` cherche directement dans l'instantané existant.
- Pour comparer deux versions : `diff -r data/<id>-…-09h00 data/<id>-…-17h30`.

## Structure d'un instantané

```
data/<id>-2026-10-05-14h30/
├── Projet X.md            # en-tête YAML : id, title, url, updated_at
├── Projet X/              # sous-documents de « Projet X »
│   ├── Réunions.md
│   ├── Réunions/
│   │   └── CR du 12-09.md
│   └── Budget.md
└── .docs-search/          # manifest.json + Markdown brut (ignoré par rg et Obsidian)
```

Les liens entre documents Docs sont réécrits en liens relatifs, ce qui permet de naviguer dans Obsidian.

## Variables d'environnement (`.env`)

| Variable | Défaut |
| --- | --- |
| `DOCS_SESSIONID` | — (rempli par `pnpm run login`) |
| `DOCS_BASE_URL` | `https://docs.numerique.gouv.fr` |
| `DOCS_DATA_DIR` | `./data` |
| `DOCS_CONCURRENCY` | `4` |

## Sécurité

- **Cookie de session** : il est envoyé seulement à l'API de `DOCS_BASE_URL`, qui doit être en HTTPS (HTTP est toléré en local, pour les tests).
  - Les liens de pagination vers un autre domaine sont refusés, et les redirections ne sont pas suivies.
  - Le format du cookie est vérifié (alphanumérique) : pas d'injection d'en-tête, ni de ligne parasite dans `.env`.
  - Le cookie n'est jamais affiché.
- **Identifiants ProConnect** : vous les saisissez vous-même dans la fenêtre du navigateur. Le script ne les voit pas.
- **Fichiers sensibles lisibles par vous seul** : `.env` (`600`), le profil de navigateur `.auth/` (`700`) et les instantanés `data/` (dossiers `700`, fichiers `600`). Ils sont tous dans `.gitignore`.
- **Titres venant du serveur** : ils sont nettoyés (ni `/`, ni `..`, ni point initial), et chaque chemin est vérifié pour rester dans l'instantané.
- **ripgrep** est lancé sans shell : les arguments lui sont passés tels quels, sans interprétation.
- **pnpm** (même configuration que [pom421/tasks](https://github.com/pom421/tasks)) :
  - version épinglée par hash dans `packageManager` ;
  - npm et yarn bloqués, par `devEngines` et par un script `preinstall` ;
  - versions publiées depuis moins de 7 jours refusées ;
  - aucun script d'installation autorisé ;
  - versions exactes, sans `^` (voir `pnpm-workspace.yaml`).

## Tests

```bash
pnpm typecheck
pnpm test        # tests de sécurité + sync/search contre une fausse API Docs (src/test/)
```

Sous Ubuntu 24.04, avec Docker (testé avec Node 22.18.0, 24.0.0 et 24.14.1) :

```bash
docker build -f docker/ubuntu.Dockerfile -t docs-search-ubuntu .
docker run --rm docs-search-ubuntu
docker build --build-arg NODE_VERSION=22.18.0 -f docker/ubuntu.Dockerfile -t docs-search-ubuntu:22 .
```
