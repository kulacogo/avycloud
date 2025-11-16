
# Product Intelligence Hub - Final Setup Guide

This guide contains all steps to deploy and debug the backend service.

## 1. CRITICAL: One-Time Permission Setup (If not already done)

If you haven't done this yet, run these commands **once** in your Cloud Shell to grant the necessary permissions.

### Step 1.1: Enable Required APIs
```sh
gcloud services enable cloudbuild.googleapis.com run.googleapis.com aiplatform.googleapis.com iam.googleapis.com --project=avycloud
```

### Step 1.2: Grant Vertex AI Permissions to the Cloud Run Service
This allows your Cloud Run service to call the Gemini API.
```sh
PROJECT_NUMBER=$(gcloud projects describe avycloud --format="value(projectNumber)")
SERVICE_ACCOUNT_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding avycloud \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/aiplatform.user"
```
---

## 2. Re-Deploy the Backend with the Latest Fix

Because we have updated the backend code, you must re-deploy it.

### Step 2.1: Navigate to the backend directory
```sh
cd backend
```

### Step 2.2: Build the new container version
```sh
gcloud builds submit --tag gcr.io/avycloud/product-hub-backend
```

### Step 2.3: Deploy the new version to Cloud Run
```sh
gcloud run deploy product-hub-backend \
  --image gcr.io/avycloud/product-hub-backend \
  --platform managed \
  --region europe-west3 \
  --allow-unauthenticated \
  --project=avycloud
```
---

## 3. How to View Logs (IMPORTANT FOR DEBUGGING)

If an error still occurs, the logs of your backend service are the only way to know why.

1.  **Go to the Cloud Run section** in the Google Cloud Console.
2.  Click on your service named `product-hub-backend`.
3.  Click on the **"LOGS"** tab.
4.  Trigger the error again in the frontend application.
5.  Look for new log entries. You should see:
    - `Received request on /api/identify`
    - `Sending request to Gemini...`
    - **`Raw Gemini Response: ...`** (This is the most important line!)
    - `Error processing identification request: ...` (If it fails, the details will be here).

By inspecting the "Raw Gemini Response", we can see exactly what the AI is sending back and why the `JSON.parse` might be failing.
