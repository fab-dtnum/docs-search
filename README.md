# docs-search

Recherche plein texte dans une arborescence [Docs](https://docs.numerique.gouv.fr) (document + sous-documents).

La recherche de Docs ne porte que sur les titres. Cet outil télécharge un document et tous ses sous-documents en Markdown, dans un **instantané daté**, puis y cherche avec [ripgrep](https://github.com/BurntSushi/ripgrep). Chaque instantané s'ouvre aussi comme un coffre **Obsidian**.

## Installation

Prérequis : Node ≥ 22.18 (exécute le TypeScript directement, version de référence dans `.nvmrc`) et ripgrep (`brew install ripgrep` sur macOS, `sudo apt install ripgrep` sur Ubuntu).

```bash
corepack enable                          # active le pnpm épinglé dans package.json
pnpm install
pnpm exec playwright install chromium    # navigateur pour `pnpm docs:login`
```

pnpm uniquement : npm et yarn sont refusés.

Si `pnpm install` échoue avec `Cannot find module …/pnpm.cjs`, c'est que le corepack livré avec votre Node est trop ancien pour pnpm 12. À partir de Node 25, corepack n'est d'ailleurs plus livré du tout. Dans les deux cas, installez-le à part :

```bash
npm install -g --ignore-scripts corepack@0.36.0 && corepack enable
```

## Connexion

Docs utilise ProConnect : pas de connexion par mot de passe depuis un script. On réutilise le cookie de session `docs_sessionid` du navigateur (valable 12 h par défaut).

```bash
pnpm docs:login
```

Une fenêtre Chromium s'ouvre et vous vous connectez vous-même. Le cookie est ensuite enregistré dans `.env`. Le profil de navigateur est conservé dans `.auth/`, donc les reconnexions suivantes sont souvent immédiates.

Sinon, vous pouvez recopier le cookie à la main : DevTools → Application → Cookies → `docs_sessionid`, à mettre dans `.env` (voir `.env.example`).

## Utilisation

`<doc>` est l'UUID du document ou son URL complète.

```bash
pnpm docs:sync <doc>                       # nouvel instantané data/<id>-AAAA-MM-JJ-HHhMM/
pnpm docs:sync <doc> --force               # tout retélécharger (ni recopie, ni reprise)
pnpm docs:search <doc> -i "copil|comité" -C2
pnpm docs:search <doc> --sync -w budget    # resynchronise avant de chercher
pnpm docs:list                             # instantanés locaux
```

Les scripts sont préfixés par `docs:` : `pnpm login`, `pnpm list` et `pnpm search` sont des commandes de pnpm lui-même (registre npm), et aucune commande de pnpm ne contient `:`.

- **sync** affiche le nombre de documents récupérés (1 document + N sous-documents) et la date de la dernière modification d'un sous-document. Les documents dont `updated_at` n'a pas changé sont recopiés depuis l'instantané précédent au lieu d'être retéléchargés.
- **Reprise après interruption** (limite de débit, coupure réseau, Ctrl-C, plantage) : chaque document téléchargé est enregistré aussitôt dans `data/.<id>.partial/`. Relancer `pnpm docs:sync <doc>` reprend là où la synchronisation s'est arrêtée : la liste des enfants est relue, et un document déjà téléchargé n'est réutilisé que s'il figure au journal de la reprise et que son `updated_at` n'a pas changé. Seuls les documents manquants ou modifiés sont retéléchargés. Le journal est écrit après chaque fichier : un fichier interrompu en cours d'écriture n'y figure pas et sera retéléchargé. `pnpm docs:list` signale les synchronisations interrompues.
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
| `DOCS_SESSIONID` | — (rempli par `pnpm docs:login`) |
| `DOCS_BASE_URL` | `https://docs.numerique.gouv.fr` |
| `DOCS_DATA_DIR` | `./data` |
| `DOCS_CONCURRENCY` | `4` |
| `DOCS_RATE_PER_MINUTE` | `60` |

Docs limite l'API des documents à 80 requêtes par minute et par utilisateur, interface web comprise. Au-delà, il répond `429` pendant environ une minute. `sync` espace donc ses requêtes (`DOCS_RATE_PER_MINUTE`, une requête par document plus une par document qui a des enfants). Un éventuel `429` déclenche une seule pause de la durée demandée (`Retry-After`). S'il se reproduit, la synchronisation s'arrête sans insister.

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

## Secrets (gitleaks)

Prérequis : [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`, ou binaire de la page des releases sous Ubuntu).

- **Avant chaque commit**, le hook `.githooks/pre-commit` analyse les changements indexés et **refuse le commit** s'il trouve un secret. Il le refuse aussi si gitleaks n'est pas installé.
  - `pnpm install` active ce hook (`git config core.hooksPath .githooks`).
  - Dans un clone déjà installé, lancez `pnpm run prepare`.
- **Règle propre au projet** dans `.gitleaks.toml` : elle détecte le cookie `docs_sessionid`, que les règles par défaut de gitleaks ne connaissent pas.
- **`pnpm secrets:scan`** analyse tout l'historique git et les changements non commités.
- **CI GitHub** (`.github/workflows/gitleaks.yml`) : elle analyse tout l'historique à chaque push sur `main` et à chaque PR.
  - Le binaire officiel est vérifié par son empreinte SHA-256, épinglée dans le workflow.
  - On n'utilise pas `gitleaks-action`, qui exige une licence payante pour les dépôts d'organisation.
- `git commit --no-verify` contourne le hook local, mais pas la CI.

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
