# Plan : `pnpm docs:import`, ajouter un sous-document depuis un fichier Markdown

À reprendre dans une PR dédiée.

## Besoin

Ajouter un nouveau document sous un document parent de Docs à partir d'un fichier Markdown local. Exemple : le compte rendu d'une réunion, rédigé en local (ou dans Obsidian), ajouté sous « Réunions ».

On ne modifie jamais un document existant. On ne fait qu'en créer un. C'est volontaire : remplacer un document (réimporter puis supprimer l'ancien) ferait perdre l'URL, le partage, les images, l'historique et les commentaires. Et modifier le contenu en place passe par le protocole d'édition collaborative, non documenté.

```bash
pnpm docs:import <parent_id|url> compte-rendu.md [--title "2026-10-05 CR COPIL"] [--dry-run]
```

## Ce que permet l'API (vérifié dans le code de `suitenumerique/docs`, pas encore testé en écriture)

- `POST /api/v1.0/documents/{parent}/children/` en `multipart/form-data`, avec le champ `file`, crée un sous-document à partir du fichier.
  - Le serveur convertit le fichier (`.md` ou `.docx`) au format de Docs. Côté code : `_apply_uploaded_file_conversion` puis `create_ydoc`.
  - Le nouveau document est placé en **dernier enfant** du parent. Il **hérite des accès du parent** : rien à recopier pour le partage.
  - ⚠️ Le serveur **remplace le titre par le nom du fichier** (`serializer.validated_data["title"] = uploaded_file.name`). Pour avoir le bon titre, il faut donc soit nommer le fichier envoyé `<titre>.md`, soit corriger le titre ensuite avec `PATCH /documents/{id}/` (`{"title": …}`). À vérifier : l'extension `.md` reste-t-elle dans le titre ?
- Configuration de l'instance (`GET /api/v1.0/config/`, public) : `CONVERSION_UPLOAD_ENABLED: true`, extensions `.docx` et `.md`, 20 Mo au maximum. Le script doit lire cette configuration et refuser avant l'envoi un fichier trop gros ou d'une autre extension.
- **CSRF** : l'API authentifie par session (`SessionAuthentication`), donc toute écriture (`POST`, `PATCH`) exige :
  - le cookie `csrftoken` **et** l'en-tête `X-CSRFToken` portant la même valeur ;
  - un en-tête `Referer` (ou `Origin`) égal à `DOCS_BASE_URL`, car Django le vérifie en HTTPS.

  Le frontend de Docs fait la même chose (`src/frontend/apps/impress/src/api/fetchApi.ts`).
- Droits : il faut pouvoir créer des enfants sous le parent (rôle éditeur au moins). Sinon l'API répond 403. Il faudra distinguer ce 403 d'une session expirée, car aujourd'hui `api.ts` traite tout 403 comme une `AuthError`.

## Étapes

1. **Jeton CSRF**
   - `login.ts` : enregistrer aussi le cookie `csrftoken` du navigateur dans `.env` (`DOCS_CSRFTOKEN`), avec le même contrôle de format que la session (alphanumérique, sans retour à la ligne).
   - Vérifier si un `GET` sur l'API pose ce cookie (`Set-Cookie: csrftoken`). Si oui, le récupérer automatiquement au premier appel, sans rien stocker.
2. **`api.ts`**
   - `request` accepte une méthode et un corps : `FormData` pour l'import, JSON pour `PATCH`.
   - Pour les écritures, il ajoute `X-CSRFToken`, `Cookie: docs_sessionid=…; csrftoken=…` et `Referer: {baseUrl}/`.
   - **Aucune nouvelle tentative automatique sur un `POST`** : refaire la requête après un délai dépassé créerait le document en double. Les nouvelles tentatives restent réservées aux `GET`.
   - Distinguer 403 « droits insuffisants » et 401/403 « session expirée » (d'après le corps `detail` de la réponse).
   - Nouvelles fonctions : `createChildFromFile(parentId, name, markdown)`, `updateTitle(id, title)`, `getConfig()`.
3. **`import.ts`**
   - Lire le fichier, vérifier l'extension et la taille d'après `getConfig()`.
   - Titre : `--title`, sinon le premier `# Titre` du Markdown, sinon le nom du fichier sans extension. Si le fichier commence par un en-tête YAML (fichier d'un instantané, par exemple), il est retiré avant l'envoi.
   - `--dry-run` : afficher le parent (titre et chemin), le titre retenu et la taille, sans rien envoyer.
   - Sinon : vérifier la session (`getMe`), afficher le parent, puis créer le document, corriger le titre si besoin, et afficher l'URL du nouveau document.
4. **`cli.ts`** : commande `import`, avec le script `docs:import` dans `package.json`.
5. **README** : documenter l'usage, la limite (« ajoute, ne modifie jamais ») et le jeton CSRF.

## Tests

- Fausse API (`src/test/fake-docs.ts`) : ajouter `POST …/children/` en multipart, `PATCH /documents/{id}/` et `GET /config/`. Elle doit vérifier le CSRF comme Django : cookie, en-tête et `Referer`, sinon 403.
- Cas à couvrir :
  - import nominal : document créé sous le bon parent, titre corrigé, URL affichée ;
  - `--dry-run` : aucune requête d'écriture ;
  - extension refusée, fichier trop gros : refus avant tout envoi ;
  - CSRF manquant : message clair ;
  - parent sans droits (403) : message distinct de « session expirée » ;
  - délai dépassé sur le `POST` : pas de nouvelle tentative, donc pas de doublon ;
  - en-tête YAML retiré, titre déduit du `# Titre`.
- Test réel : sur un document de test désigné par l'utilisateur, jamais sur un document partagé. Vérifier dans Docs la conversion (titres, listes, tableaux, liens) et le titre final.
- Docker Ubuntu 24.04 et `pnpm secrets:scan` avant la PR.

## Hors périmètre

- Modifier ou remplacer un document existant (voir « Besoin »).
- Pièces jointes et images locales : seul le texte Markdown est envoyé. Les images référencées par URL restent des liens.
