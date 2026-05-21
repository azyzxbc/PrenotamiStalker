# Prenotami Appointment Monitor

## Description

Script de monitoring automatique pour les rendez-vous **Legalizzazioni** sur le portail [prenotami.esteri.it](https://prenotami.esteri.it) (Ambassade d'Italie à Tunis).

**Fonctionnalités :**
- 🔄 Vérifie la disponibilité des créneaux toutes les 2 minutes
- 🔑 Login automatique via SSO (iam.esteri.it) + re-login automatique à l'expiration de session
- 📱 Notification Telegram (5 messages répétés pour ne pas rater)
- 🔊 Alarme sonore sur le PC
- 🛡️ Utilise un vrai Chrome (non-headless) pour éviter la détection anti-bot (Radware)

---

## Architecture

```
prenotami-monitor/
├── monitor.js          # Script principal
├── package.json        # Dépendances npm
├── .env                # Configuration (credentials, Telegram, etc.)
├── .env.example        # Template de configuration
├── .gitignore          # Fichiers à exclure
├── chrome-profile/     # Profil Chrome dédié (généré automatiquement)
└── README.md           # Ce fichier
```

---

## Prérequis

| Logiciel | Version | Lien |
|----------|---------|------|
| Node.js | v18+ (LTS recommandé) | https://nodejs.org |
| Google Chrome | Dernière version | https://google.com/chrome |
| Compte Telegram | - | https://telegram.org |
| Compte Prenotami | - | https://prenotami.esteri.it |

---

## Installation

### 1. Cloner/Copier le projet

```bash
# Sur Windows
mkdir C:\prenotami-monitor
# Copier tous les fichiers du projet dans ce dossier

# Sur Linux (VPS)
mkdir ~/prenotami-monitor
cd ~/prenotami-monitor
# Copier les fichiers: monitor.js, package.json, .env.example, .gitignore
```

### 2. Installer les dépendances

```bash
cd prenotami-monitor
npm install
```

### 3. Créer un Bot Telegram

1. Ouvrir Telegram et chercher **@BotFather**
2. Envoyer `/newbot`
3. Choisir un nom et un username
4. **Copier le token** reçu (ex: `1234567890:AAHxxxxxxxxxxxxxxxxxxxxxx`)
5. Envoyer un message quelconque au nouveau bot
6. Ouvrir dans le navigateur :
   ```
   https://api.telegram.org/bot<VOTRE_TOKEN>/getUpdates
   ```
7. **Copier le chat_id** (le nombre dans `"chat":{"id": XXXXXXX}`)

### 4. Configurer le fichier .env

```bash
cp .env.example .env
# Puis éditer .env avec vos valeurs
```

Contenu du `.env` :
```env
# === Identifiants Prenotami ===
PRENOTAMI_EMAIL=votre_email@example.com
PRENOTAMI_PASSWORD="votre_mot_de_passe"
# ⚠️ IMPORTANT: Si le mot de passe contient # ou des caractères spéciaux,
# mettez-le entre guillemets doubles !

# === Telegram ===
TELEGRAM_BOT_TOKEN=votre_token_bot
TELEGRAM_CHAT_ID=votre_chat_id

# === Paramètres de monitoring ===
CHECK_INTERVAL_MS=120000
# Intervalle entre les vérifications en millisecondes (120000 = 2 minutes)

BOOKING_URL=https://prenotami.esteri.it/Services/Booking/2359
# URL du service à surveiller (2359 = Legalizzazioni à Tunis)
```

---

## Utilisation

### Démarrer le monitoring

```bash
npm start
# ou
node monitor.js
```

### Commandes disponibles

| Commande | Description |
|----------|-------------|
| `npm start` | Démarrer le monitoring |
| `npm run setup` | Ouvrir Chrome pour login manuel (optionnel) |
| `npm run test-telegram` | Envoyer un message test Telegram |
| `npm run test-sound` | Tester l'alarme sonore |

### Logs de fonctionnement

```
✅ SUCCESS: Logged in! URL: https://prenotami.esteri.it/UserArea
🔍 CHECK: Check #1 — Loading booking page...
ℹ️ INFO: No slots available (Redirected to /Services). Next check in 120s...
⚠️ WARNING: Not logged in — auto re-login...
✅ SUCCESS: Re-login successful! Retrying check...
🚨🚨🚨 SLOTS POSSIBLY AVAILABLE! 🚨🚨🚨
```

---

## Déploiement sur VPS Linux (Ubuntu/Debian)

### 1. Préparer le serveur

```bash
# Mettre à jour le système
sudo apt update && sudo apt upgrade -y

# Installer Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Vérifier
node --version  # v20.x.x
npm --version   # 10.x.x
```

### 2. Installer Google Chrome

```bash
# Télécharger et installer Chrome
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y

# Vérifier
google-chrome --version
```

### 3. Installer un écran virtuel (Xvfb)

Chrome nécessite un écran même sur un serveur. Xvfb crée un écran virtuel.

```bash
sudo apt install -y xvfb
```

### 4. Copier le projet sur le VPS

```bash
# Depuis votre PC (PowerShell/cmd)
cd C:\prenotami-monitor

# Puis copiez les fichiers vers le VPS
scp monitor.js user@VPS_IP:~/prenotami-monitor/
scp package.json user@VPS_IP:~/prenotami-monitor/
scp .env user@VPS_IP:~/prenotami-monitor/
scp .gitignore user@VPS_IP:~/prenotami-monitor/
```

Ou bien créez les fichiers directement sur le VPS.

### 5. Installer les dépendances sur le VPS

```bash
cd ~/prenotami-monitor
npm install
```

### 6. Modifier le chemin Chrome dans monitor.js (Linux)

Le script détecte automatiquement Chrome sur Windows. Sur Linux, ajoutez le chemin dans la fonction `findBrowserPath()` du fichier `monitor.js`. Ajoutez ces lignes dans le tableau `candidates` :

```javascript
'/usr/bin/google-chrome',
'/usr/bin/google-chrome-stable',
'/usr/bin/chromium-browser',
```

### 7. Lancer avec Xvfb

```bash
# Test rapide
xvfb-run --auto-servernum node monitor.js

# Si ça marche, passez à pm2 (étape 8)
```

### 8. Installer pm2 (Process Manager)

pm2 garde le script en vie 24/7, le redémarre en cas de crash, et le relance au boot du serveur.

```bash
# Installer pm2
sudo npm install -g pm2

# Démarrer le monitoring avec xvfb
cd ~/prenotami-monitor
pm2 start monitor.js --name prenotami -- --no-sandbox
# OU avec xvfb intégré :
pm2 start "xvfb-run --auto-servernum node monitor.js" --name prenotami

# Commandes pm2 utiles
pm2 status              # Voir le statut
pm2 logs prenotami      # Voir les logs en temps réel
pm2 logs prenotami --lines 50   # Dernières 50 lignes
pm2 restart prenotami   # Redémarrer
pm2 stop prenotami      # Arrêter
pm2 delete prenotami    # Supprimer

# Auto-démarrage au boot du serveur
pm2 startup             # Suivre les instructions affichées
pm2 save                # Sauvegarder la configuration
```

### 9. Vérifier que ça tourne

```bash
pm2 logs prenotami --lines 20
```

Vous devriez voir :
```
✅ SUCCESS: Logged in! URL: https://prenotami.esteri.it/UserArea
🔍 CHECK: Check #1 — No slots available (Redirected to /Services)...
```

---

## Comment ça marche

### Flux de monitoring

```
Démarrage
    │
    ▼
Auto-login via SSO (iam.esteri.it)
    │
    ▼
┌─────────────────────────────────┐
│  Charger la page de booking     │◄──────────┐
│  /Services/Booking/2359         │           │
└──────────────┬──────────────────┘           │
               │                              │
      ┌────────┴────────┐                     │
      │                 │                     │
  Redirigé vers     Reste sur la page         │
  /Services ou      de booking                │
  /Home                  │                    │
      │                  │                    │
  PAS DE CRÉNEAUX    CRÉNEAUX DISPO!         │
      │                  │                    │
  Attendre 2min     📱 5x Telegram           │
      │              🔊 Alarme sonore         │
      │                  │                    │
      └──────────────────┴────────────────────┘

Session expirée ?  →  Auto re-login  →  Continuer
```

### Détection des créneaux

Le site prenotami redirige différemment selon la disponibilité :

| Situation | URL finale | Action du script |
|-----------|-----------|-----------------|
| Pas de créneaux | `/Services` ou `/Home` | Log "No slots", attendre |
| Session expirée | `iam.esteri.it` ou `/Home` (non connecté) | Auto re-login |
| Créneaux disponibles | `/Services/Booking/2359` (reste sur la page) | **ALERTE !** |

---

## Trouver l'URL d'un autre service

Si vous voulez surveiller un service différent (Passaporto, Cittadinanza, etc.) :

| Service | URL |
|---------|-----|
| Passaporto | `/Services/Booking/1167` |
| Stato civile | `/Services/Booking/2356` |
| Anagrafe / A.I.R.E. | `/Services/Booking/2357` |
| Cittadinanza per discendenza | `/Services/Booking/2358` |
| **Legalizzazioni** | **`/Services/Booking/2359`** |
| CIE | `/Services/Booking/5111` |

Modifiez `BOOKING_URL` dans `.env` avec l'URL souhaitée.

---

## Dépannage

### "Invalid username or password"
- Vérifiez que le mot de passe dans `.env` est entre **guillemets doubles** si il contient `#`, `$`, ou des caractères spéciaux
- Vérifiez que vous pouvez vous connecter manuellement sur https://prenotami.esteri.it

### "Navigation timeout"
- Le site est lent ou temporairement indisponible
- Le script réessaiera automatiquement

### "Detached Frame"
- Le navigateur Chrome a crashé
- Si vous utilisez pm2, il redémarrera automatiquement

### "The browser is already running"
- Fermez toutes les instances de Chrome
- `taskkill /IM chrome.exe /F` (Windows) ou `pkill chrome` (Linux)

### Telegram ne fonctionne pas
- Vérifiez le token et le chat_id dans `.env`
- Testez avec `npm run test-telegram`
- Assurez-vous d'avoir envoyé un message au bot avant de récupérer le chat_id

---

## Sécurité

- ⚠️ **Ne partagez jamais votre fichier `.env`** — il contient vos mots de passe
- Le fichier `.env` est dans `.gitignore` et ne sera pas versionné
- Ce script est uniquement pour la **notification** — il ne réserve pas automatiquement
