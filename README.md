# avycloud

## Product Intelligence Hub - Final Setup Guide

This guide contains all steps to deploy and debug the backend service.

### 1. CRITICAL: One-Time Permission Setup

If du es noch nicht erledigt hast, führe diese Befehle **einmal** in Cloud Shell aus, um alle benötigten Rechte zu vergeben.

```sh
gcloud services enable cloudbuild.googleapis.com run.googleapis.com aiplatform.googleapis.com iam.googleapis.com --project=avycloud

PROJECT_NUMBER=$(gcloud projects describe avycloud --format="value(projectNumber)")
SERVICE_ACCOUNT_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding avycloud \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/aiplatform.user"
```

### 2. Backend neu deployen

```sh
cd backend
gcloud builds submit --tag gcr.io/avycloud/product-hub-backend
gcloud run deploy product-hub-backend \
  --image gcr.io/avycloud/product-hub-backend \
  --platform managed \
  --region europe-west3 \
  --allow-unauthenticated \
  --project=avycloud
```

### 3. Cloud-Run-Logs prüfen

1. Cloud Console → Cloud Run → `product-hub-backend`
2. Tab **LOGS** öffnen
3. Fehler im Frontend reproduzieren
4. Neue Einträge prüfen, speziell:
   - `Received request on /api/identify`
   - `Sending request to Gemini...`
   - `Raw Gemini Response: ...`
   - `Error processing identification request: ...`

So siehst du exakt, was das Modell zurückgibt und warum das Parsing ggf. scheitert.

---

## CI/CD Automatisierung

### Cloud Run (Backend)

1. **GitHub-Trigger autorisieren**  
   - Cloud Console → Cloud Build → *Triggers* → *Create Trigger* → Quelle **GitHub** → Repo `kulacogo/avycloud`.
2. **Trigger-Konfiguration**  
   - Branch: `main`  
   - Build-Config: `backend/cloudbuild.yaml`
3. **CLI (optional)**  
   ```sh
   gcloud beta builds triggers create github \
     --name="avycloud-backend" \
     --repo-owner=kulacogo \
     --repo-name=avycloud \
     --branch-pattern="^main$" \
     --build-config=backend/cloudbuild.yaml
   ```
4. Der Build verwendet `backend/cloudbuild.yaml`, baut das Docker-Image und deployt nach Cloud Run. Der Cloud-Build-Service-Account muss `Cloud Run Admin` + `Service Account User` besitzen.

### Firebase Hosting (Frontend)

1. **GitHub Secret setzen**  
   - In GitHub → Repo → *Settings* → *Secrets and variables* → *Actions*  
   - Secret `FIREBASE_SERVICE_ACCOUNT` hinzufügen (JSON eines Firebase-Service-Accounts mit Hosting-Deploy-Rechten).  
2. **Workflow aktiv**  
   - `.github/workflows/firebase-hosting.yml` führt bei jedem Push auf `main` aus: `npm ci`, `npm run build`, anschließendes Hosting-Deploy über `FirebaseExtended/action-hosting-deploy@v0`.  
   - Standard-Projekt: `avycloud`. Für Preview-Channels `channelId` anpassen.

Damit laufen Backend-Deployments automatisch über Cloud Build + Cloud Run, Frontend-Deployments über GitHub Actions + Firebase Hosting. Nur die einmalige Trigger-/Secret-Konfiguration ist manuell nötig.
