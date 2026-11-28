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

L’accueil propose les thèmes **Clair** et **Sombre**, avec un bouton lune ou soleil dans la navigation. Le thème clair est utilisé à la première visite et le navigateur mémorise ensuite le choix. Voter, donner un avis ou proposer une réponse en mode surprise demande un compte étudiant. Les réponses sont limitées à une par compte, par formulaire et par séance, même sur plusieurs appareils. Le nom, l’e-mail, la réponse et sa date sont consultables par les membres autorisés du comité ; ces informations ne sont jamais affichées publiquement. Un code d’inscription partagé peut être défini avec `STUDENT_SIGNUP_CODE`. Il contrôle l’accès à l’inscription. La création de compte ne valide pas l’adresse e-mail auprès de l’établissement.

## Accès du comité

Les trois identifiants et leurs mots de passe sont distincts. Chaque mot de passe doit compter au moins 12 caractères.

| Rôle | Droits |
| --- | --- |
| Responsable | Organisation, modération, QR codes, exports, archivage, traçabilité et dates de naissance facultatives |
| Organisateur | Gestion des activités et sondages, publication, modération, QR codes et participations nominatives |
| Lecteur | Consultation du tableau de bord, des résultats et des avis sans identités |

Les sessions sont renouvelées lors de l’utilisation et conservées en base après redémarrage. Leur durée d’inactivité maximale est d’un an pour les étudiants et de 180 jours pour le comité. Se déconnecter révoque la session de cet appareil.

## Mot de passe étudiant

Le lien « Mot de passe oublié » envoie un lien personnel valable 30 minutes, utilisable une seule fois. Changer son mot de passe depuis son compte demande le mot de passe actuel. Les deux opérations ferment les sessions existantes sur tous les appareils. Les accès administrateurs restent définis par les variables `ADMIN_*` de Render.

Configurer l’expéditeur dans les variables Render : `SMTP_HOST`, `SMTP_PORT` (587 avec STARTTLS ou 465 avec `SMTP_SECURE=true`), `SMTP_SECURE`, `SMTP_FROM` (adresse e-mail autorisée par le fournisseur), `SMTP_USER` et `SMTP_PASSWORD`. Les deux derniers paramètres sont fournis ensemble si le service demande une authentification. Conserver l’origine HTTPS du site dans `PUBLIC_URL`, ou utiliser l’adresse Render détectée automatiquement. Sans service SMTP configuré, l’interface indique explicitement que la récupération par e-mail est indisponible. Les réponses publiques et les journaux ne contiennent jamais le lien secret.

Le responsable dispose d’une solution sans SMTP : **Étudiants et participations → Ouvrir la fiche → Créer un lien de réinitialisation**. Après vérification de l’identité, il transmet le lien personnel de 30 minutes à l’étudiant. Ce lien apparaît uniquement dans cette réponse administrateur, n’est pas enregistré dans le navigateur et est effacé à la fermeture de la fiche. La génération d’un nouveau lien invalide les précédents ; son utilisation ferme toutes les sessions du compte. **Paramètres et diffusion → Mon accès** affiche l’état de la configuration SMTP.

## Sondage de fréquence et gestion quotidienne

La rubrique **Sondage prioritaire** pilote la consultation, active par défaut au premier démarrage de cette version. Les commandes **Lancer**, **Suspendre** et **Terminer** sont visibles dans cette rubrique. Elle propose « Chaque semaine » ou « Toutes les deux semaines », puis un jour du lundi au samedi, avec une question par étape et un retournement 3D entre les étapes. La fenêtre apparaît à l’ouverture pour les étudiants qui n’ont pas encore répondu ; elle peut être fermée et reste accessible dans la page. Si un autre dialogue est ouvert, elle attend sa fermeture. Chaque compte ne peut répondre qu’une fois. Suspendre, reprendre ou arrêter la collecte conserve les réponses ; relancer ne crée pas une nouvelle campagne ni un nouveau droit de vote. Les animations respectent le réglage de réduction des mouvements.

La date de naissance est facultative et sert à préparer les anniversaires et les célébrations individuelles ou groupées. L’étudiant voit cette explication et donne son accord pour partager sa date. Une seconde case, facultative et non cochée par défaut, autorise les publications avec le nom et le jour/mois, sans publier l’année. Aucun anniversaire n’est publié automatiquement. Cette finalité est préremplie uniquement si aucun usage n’avait été défini ; les paramètres personnalisés et les sondages fermés/suspendus sont conservés. Les étudiants ayant déjà répondu peuvent ajouter leur date ensuite sans voter une deuxième fois, tant que la collecte reste ouverte. Un changement d’utilisation exige un nouvel accord. Seul le responsable peut consulter ces dates et les exporter. Les réponses, dates et identités sont accessibles dans **Étudiants et participations** ; la date des anciens votes qui ne la stockaient pas reste inconnue.

## Annuaire et filières

L’inscription demande le prénom, le nom, la filière et la licence (1, 2 ou 3). Les filières initiales sont **GE/SI**, **GE/SIL**, **GE/RIT** et **GE/ASCII**. Chaque étudiant peut compléter ou modifier son parcours dans **Mon compte étudiant**. Les anciens comptes ne sont pas complétés artificiellement : les champs manquants restent « Non renseigné ».

Dans **Étudiants et participations**, le comité filtre par nom/e-mail, filière, licence et période d’inscription. Le responsable peut aussi filtrer par mois d’anniversaire et accord de publication, puis exporter l’ensemble des résultats filtrés en Excel ou Word. Une fiche affiche les coordonnées, les compteurs, la dernière connexion et un historique paginé des votes, avis, connexions et autres actions avec la séance et la date. Les filières se gèrent dans l’onglet **Filières** : ajout et renommage par les organisateurs, archivage/réactivation par le responsable. Archiver une filière la retire des nouvelles inscriptions tout en conservant les profils et leur historique.

## Souvenirs des séances

**Médiathèque des séances → Ajouter un média** importe un fichier de l’appareil et le rattache à une séance. Photos JPEG/PNG/WebP : 5 Mo maximum, normalisées en WebP avec retrait des métadonnées. Vidéos MP4 : 50 Mo maximum ; stockage total de la galerie : 250 Mo. Les médias sont stockés dans la base PostgreSQL/SQLite, jamais sur le disque temporaire de Render. Le lecteur vidéo prend en charge les requêtes partielles et la navigation dans la vidéo. Un administrateur peut prévisualiser les médias privés et les supprimer.

Les souvenirs sont publics uniquement pour une séance publiée dont la date annoncée est passée (ou sans annonce). Les brouillons, archives et séances futures restent privés. Les médias ajoutés rejoignent les souvenirs initiaux dans un défilement automatique doux ; celui-ci s’arrête au survol, au clavier, pendant une lecture vidéo, quand la page est masquée ou avec réduction des mouvements.

Le catalogue permet de créer/modifier chaque activité, son image, sa question et 2 à 8 choix de réponse. Les images JPEG, PNG ou WebP de moins de 5 Mo peuvent être importées depuis l’ordinateur ; elles sont conservées dans la base et survivent aux mises à jour Render. Les nouvelles séances proposent toutes les activités actives ; le comité choisit celles qu’il souhaite inclure. Le sondage d’une séance et ses avis ont des commandes d’ouverture/fermeture séparées.

## Gestion des séances

Une séance peut correspondre à toute activité du catalogue. Dans **Gérer les séances**, les onglets **À venir**, **En cours** et **Passées** regroupent les séances enregistrées. **Nouvelle séance** permet de choisir la période et l’activité réelle ; les activités proposées au vote restent un choix séparé. Passer une séance en « Passée » ferme son vote et conserve sa publication, ses avis et ses souvenirs. L’archivage est une commande distincte qui retire la diffusion publique. Depuis une séance passée, le comité peut ajouter ses photos/vidéos ; l’action de suite du film est proposée pour une séance cinéma. Les deux séances historiques sont conservées et aucune fausse séance n’est générée pour remplir le catalogue.

## Suite d’une séance cinéma

Depuis **Suite des films**, sélectionner la séance puis renseigner le titre, l’URL de l’extrait et le lien facultatif du film intégral. Le même formulaire reste accessible dans **Séances et sondages**. L’extrait est un fichier MP4 directement accessible en HTTPS, hébergé sur un service vidéo ou de fichiers prenant en charge les requêtes HTTP Range (réponses 206, sans redirection). Sa durée réelle est vérifiée côté serveur ; au-delà de 30 minutes, la publication est refusée. La durée indiquée par le navigateur n’est pas utilisée comme preuve. La lecture de l’extrait demande un compte étudiant et la séance doit être publiée. Si une date de séance est annoncée, l’extrait et ses liens ne sont diffusés qu’après cette date ; une annonce invalide bloque la diffusion. L’aperçu administrateur reste disponible pendant la préparation.

Les vidéos longues ne sont pas stockées dans PostgreSQL ni dans le disque temporaire de Render : le formulaire attend l’URL du fichier hébergé. Le comité peut désactiver, modifier ou retirer l’extrait. Le lien vers le film complet est indépendant et peut pointer vers une page de visionnage.

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
