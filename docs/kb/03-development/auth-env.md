## AvyCloud Auth Environment Variables

### Frontend (Vite) (`.env.local`)

- **VITE_BACKEND_URL**: Backend base URL (local dev) e.g. `http://localhost:8080`
- **VITE_USE_PRODUCTION_BACKEND**: Set to `true` only if you explicitly want prod backend in dev

Firebase Web Config (Firebase Console → Project settings → Your apps → Web app):

- **VITE_FIREBASE_API_KEY**
- **VITE_FIREBASE_AUTH_DOMAIN**
- **VITE_FIREBASE_PROJECT_ID**
- **VITE_FIREBASE_APP_ID**
- **VITE_FIREBASE_STORAGE_BUCKET** (optional, but recommended)
- **VITE_FIREBASE_MESSAGING_SENDER_ID** (optional, but recommended)

### Backend (Cloud Run env)

- **GOOGLE_CLOUD_PROJECT**: GCP project id (Cloud Run sets this automatically)
- **AUTH_ALLOWED_EMAIL_DOMAIN**: Must be `trendocean.de`
- **AUTH_BOOTSTRAP_ADMIN_EMAIL**: Must be `admin@trendocean.de`
- **AUTH_ACTION_CONTINUE_URL**: After reset/verify, redirect here (e.g. `https://avycloud.web.app/#/dashboard` or `https://avycloud.web.app/#/home`)

SMTP (Strato):
- **SMTP_FROM**: `admin@trendocean.de`
- **SMTP_HOST**: `smtp.strato.de`
- **SMTP_PORT**: `465`
- **SMTP_SECURE**: `true`
- SMTP password is loaded from Secret Manager: **`Admin_Mail_Secret`**

