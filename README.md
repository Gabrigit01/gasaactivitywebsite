# UATM GASA · Vie étudiante

Le site étudiant et l’espace comité partagent une base de données. Avec `DATABASE_URL`, l’application utilise PostgreSQL, notamment Neon. Sans cette variable, les essais locaux utilisent SQLite dans `data/gasa.sqlite`. L’application est prévue pour Node.js 24 LTS ou pour le conteneur fourni.

## Essai local

Dans le terminal de Visual Studio Code, depuis ce dossier :

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm start
```

- **Site étudiant** — [localhost:3000](http://localhost:3000/)
- **Espace comité** — [localhost:3000/admin](http://localhost:3000/admin)

Renseigner les trois identifiants et mots de passe du comité dans `.env`. Pour un essai local avec un seul accès responsable, la variable historique `ADMIN_PASSWORD` reste disponible lorsque les comptes nominatifs sont vides.

L’accueil propose les thèmes **Clair** et **Sombre**, avec un bouton lune ou soleil dans la navigation. Le thème clair est utilisé à la première visite et le navigateur mémorise ensuite le choix. Voter, donner un avis ou proposer une réponse en mode surprise demande un compte étudiant. Les réponses sont limitées à une par compte, par formulaire et par séance, même sur plusieurs appareils. Le nom et l’e-mail ne figurent pas dans les avis du tableau de bord ou dans les exports. Un code d’inscription partagé peut être défini avec `STUDENT_SIGNUP_CODE`. Il contrôle l’accès à l’inscription. La création de compte ne valide pas l’adresse e-mail auprès de l’établissement.

## Accès du comité

Les trois identifiants et leurs mots de passe sont distincts. Chaque mot de passe doit compter au moins 12 caractères.

| Rôle | Droits |
| --- | --- |
| Responsable | Organisation, modération, QR codes, exports, archivage et retrait de publication |
| Organisateur | Gestion des activités et sondages, publication, modération et QR codes |
| Lecteur | Consultation du tableau de bord et des résultats |

Les sessions sont renouvelées lors de l’utilisation et conservées en base après redémarrage. Leur durée d’inactivité maximale est d’un an pour les étudiants et de 180 jours pour le comité. Se déconnecter révoque la session de cet appareil.

## Notifications

Générer une paire de clés de notification avec la commande suivante et conserver la même paire à chaque redéploiement :

```powershell
npx web-push generate-vapid-keys
```

Renseigner `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` dans l’environnement du serveur. Pour le sujet, utiliser par exemple `mailto:` suivi d’une adresse de contact réelle du comité.

Les étudiants peuvent activer ou désactiver les notifications sur chaque appareil depuis le pied de page. Les bulletins publics sont reçus même si le site est fermé ou le compte déconnecté, dès que l’appareil et le navigateur peuvent livrer la notification. Une annonce programmée en mode surprise garde le nom de l’activité confidentiel jusqu’à la révélation. Sur iPhone et iPad, ajouter le site à l’écran d’accueil, l’ouvrir depuis son icône, puis activer les notifications. [Conditions Web Push sur iOS et iPadOS](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/#web-push-on-ios-and-ipados)

## Déploiement

### Render avec Neon

Le site est un **Web Service** Node.js public. Neon fournit la base **PostgreSQL** externe : aucun service Postgres supplémentaire, Private Service ou Background Worker n’est nécessaire dans Render pour cette configuration.

1. Dans Neon, ouvrir le projet et copier sa chaîne de connexion PostgreSQL depuis **Connect**. Conserver les options SSL de cette chaîne. Tout mot de passe déjà partagé doit être remplacé avant la mise en ligne.
2. Mettre la version testée du projet sur GitHub. Dans Render, choisir **New → Web Service**, connecter GitHub et sélectionner le dépôt et la branche `main`.
3. Choisir **Node**, laisser **Root Directory** vide, saisir `npm ci --omit=dev` dans **Build Command** et `npm start` dans **Start Command**. Définir le **Health Check Path** à `/healthz`.
4. Dans **Environment**, ajouter les variables suivantes, une clé et une valeur par champ. Saisir les secrets directement dans Render, sans les publier dans GitHub.

   | Variable | Valeur |
   | --- | --- |
   | `NODE_VERSION` | `24` |
   | `NODE_ENV` | `production` |
   | `HOST` | `0.0.0.0` |
   | `TRUST_PROXY` | `1` |
   | `DATABASE_URL` | Chaîne de connexion Neon, avec son nouveau mot de passe |
   | `ADMIN_OWNER_USERNAME` / `ADMIN_OWNER_PASSWORD` | Identifiant et mot de passe du responsable |
   | `ADMIN_ORGANIZER_USERNAME` / `ADMIN_ORGANIZER_PASSWORD` | Identifiant et mot de passe de l’organisateur |
   | `ADMIN_VIEWER_USERNAME` / `ADMIN_VIEWER_PASSWORD` | Identifiant et mot de passe du lecteur |
   | `VAPID_SUBJECT` | `mailto:` suivi de l’adresse de contact réelle |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Les deux clés de notification générées ensemble |

5. Laisser Render fournir `PORT`. L’application utilise automatiquement `RENDER_EXTERNAL_URL` pour son adresse HTTPS. Lors de l’ajout d’un domaine personnalisé, définir `PUBLIC_URL` à son origine HTTPS exacte, sans chemin.
6. Déployer, attendre l’état **Live**, puis ouvrir le site et `/healthz`. Tester l’inscription étudiante, un vote, un avis et les trois accès du comité. Vérifier aussi que les données et les connexions restent présentes après un redéploiement.

Avec Neon, les données sont conservées dans PostgreSQL : aucun disque persistant Render ni `DATA_DIR` n’est nécessaire. La base est initialisée au premier démarrage. **Les données SQLite de l’ordinateur ne sont pas transférées automatiquement vers Neon.**

Les anciennes bases PostgreSQL utilisant des noms de colonnes en minuscules ou avec des underscores sont migrées automatiquement au démarrage, dans une transaction. Les données, clés étrangères et index sont conservés. Les activités et séances de démonstration ne sont ajoutées que lorsque ces deux tables sont vides ; une base importée contenant déjà des activités ou des séances n’est pas réinitialisée. En cas de noms de colonnes ambigus, le démarrage s’arrête avec un diagnostic et la migration est annulée.

L’offre Render gratuite convient à une prévisualisation. Elle met le serveur en veille après 15 minutes sans trafic : une notification programmée pendant cette veille ne pourra être traitée qu’au réveil du serveur. Une instance payante évite cette veille pour le fonctionnement continu du site. [Documentation Render : Web Services](https://render.com/docs/web-services), [limites de l’offre gratuite](https://render.com/docs/free).

### Autre hébergement ou SQLite persistante

Utiliser un domaine HTTPS et renseigner son origine dans `PUBLIC_URL`. Activer `NODE_ENV=production`, configurer les trois comptes administrateurs et les notifications, puis lancer `npm ci --omit=dev` et `npm start`, ou construire l’image Docker. Derrière un seul proxy de confiance qui termine HTTPS, renseigner `TRUST_PROXY=1`. L’URL de vérification interne est `/healthz`.

Pour PostgreSQL, renseigner `DATABASE_URL` et prévoir les sauvegardes auprès du fournisseur de base. Pour SQLite, laisser `DATABASE_URL` vide et monter un volume persistant accessible en écriture à l’emplacement défini par `DATA_DIR`. Prévoir une sauvegarde SQLite régulière, par le mécanisme de l’hébergeur ou après l’arrêt de l’application. Conserver les secrets de production et la même paire de clés VAPID à chaque redéploiement.

Exemple de lancement du conteneur derrière un proxy local :

```powershell
docker build -t gasa-campus .
docker volume create gasa-data
docker run --env-file .env.production --mount source=gasa-data,target=/app/data -p 127.0.0.1:3000:3000 gasa-campus
```

Les fichiers `.env` et `.env.production` sont locaux et ignorés par Git. Le conteneur attend un proxy HTTPS et utilise SQLite à l’emplacement `/app/data` par défaut ; une valeur `DATABASE_URL` sélectionne PostgreSQL. En conservant la même base SQLite, les votes et les avis enregistrés avant cette version restent disponibles. Les réponses historiques d’un navigateur sont rattachées à son premier compte connecté lorsque ce compte n’a pas déjà répondu à la même séance.

## Sauvegarde du style Cinéma

La version avec le carrousel cinéma a été sauvegardée dans C:/Users/HP/Desktop/Sauvegardeversite/GASA-Cinema-20261117-202443.zip. Elle contient le code et les médias de cette version. Pour la réessayer, extraire cette archive dans un dossier distinct, installer ses dépendances et renseigner ses propres paramètres d’environnement.
