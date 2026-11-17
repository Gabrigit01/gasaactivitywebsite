# UATM GASA · Vie étudiante

Le site étudiant et l’espace comité partagent une base SQLite. L’application est prévue pour Node.js 24 LTS ou pour le conteneur fourni.

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

1. Utiliser un domaine **HTTPS** et renseigner son origine dans `PUBLIC_URL` (par exemple `https://activites.exemple.bj`).
2. Activer `NODE_ENV=production`, renseigner les six paramètres `ADMIN_*_USERNAME` et `ADMIN_*_PASSWORD` et les trois paramètres VAPID pour les notifications. Utiliser le gestionnaire de secrets de l’hébergeur.
3. Lancer une instance Node avec `npm ci --omit=dev` et `npm start`, ou construire l’image Docker. Monter un volume persistant à l’emplacement défini par `DATA_DIR`. Le volume doit être accessible en écriture par l’utilisateur de l’application.
4. Derrière un seul proxy de confiance qui termine HTTPS, renseigner `TRUST_PROXY=1` et transmettre les bons en-têtes de protocole et d’hôte. L’URL de vérification interne est `/healthz`.
5. Prévoir une sauvegarde SQLite régulière, par le mécanisme de sauvegarde de l’hébergeur ou après l’arrêt de l’application. Conserver aussi les secrets de production et les clés VAPID.

Exemple de lancement du conteneur derrière un proxy local :

```powershell
docker build -t gasa-campus .
docker volume create gasa-data
docker run --env-file .env.production --mount source=gasa-data,target=/app/data -p 127.0.0.1:3000:3000 gasa-campus
```

Les fichiers `.env` et `.env.production` sont locaux et ignorés par Git. Le conteneur attend un proxy HTTPS et utilise une base à l’emplacement `/app/data` par défaut. Les votes et les avis enregistrés avant cette version restent dans la base. Les réponses historiques d’un navigateur sont rattachées à son premier compte connecté lorsque ce compte n’a pas déjà répondu à la même séance.

## Sauvegarde du style Cinéma

La version avec le carrousel cinéma a été sauvegardée dans C:/Users/HP/Desktop/Sauvegardeversite/GASA-Cinema-20261117-202443.zip. Elle contient le code et les médias de cette version. Pour la réessayer, extraire cette archive dans un dossier distinct, installer ses dépendances et renseigner ses propres paramètres d’environnement.
