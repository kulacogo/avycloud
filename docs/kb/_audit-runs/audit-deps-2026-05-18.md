# Deps Audit — 2026-05-18

Root package: `/Users/oguz/Dev/avycloud/package.json`
Backend package: `/Users/oguz/Dev/avycloud/backend/package.json`
Files scanned: 765

## Findings

| Package | Section | Declared? | Used? | Classification |
|---------|---------|-----------|-------|----------------|
| @google-cloud/firestore | backend/deps | yes | yes | USED |
| @google-cloud/secret-manager | backend/deps | yes | yes | USED |
| @google-cloud/storage | backend/deps | yes | yes | USED |
| @google/genai | root/deps | yes | yes | USED |
| @google/genai | backend/deps | yes | yes | USED |
| @google/generative-ai | root/deps | yes | yes | USED |
| @google/generative-ai | backend/deps | yes | yes | USED |
| @imgly/background-removal | root/deps | yes | yes | USED |
| @tanstack/react-query | root/deps | yes | yes | USED |
| @types/dompurify | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| @types/react | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| @types/react-dom | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| @vitejs/plugin-react | root/devDeps | yes | yes | DEV_DEAD: not used in tests/scripts |
| @zxing/browser | root/deps | yes | yes | USED |
| ajv | backend/deps | yes | yes | USED |
| ajv-formats | backend/deps | yes | yes | USED |
| autoprefixer | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| cors | backend/deps | yes | yes | USED |
| csv-parse | backend/deps | yes | yes | USED |
| dompurify | root/deps | yes | yes | USED |
| express | backend/deps | yes | yes | USED |
| express-rate-limit | backend/deps | yes | yes | USED |
| fast-xml-parser | backend/deps | yes | yes | USED |
| firebase | root/deps | yes | yes | USED |
| firebase-admin | backend/deps | yes | yes | USED |
| framer-motion | root/deps | yes | no | DEAD |
| geoip-lite | backend/deps | yes | yes | USED |
| google-auth-library | backend/deps | yes | yes | USED |
| helmet | backend/deps | yes | yes | USED |
| html5-qrcode | root/deps | yes | yes | USED |
| multer | backend/deps | yes | yes | USED |
| node-fetch | undeclared | no | yes | ERROR: imported but not declared |
| nodemailer | backend/deps | yes | yes | USED |
| p-limit | undeclared | no | yes | ERROR: imported but not declared |
| p-queue | backend/deps | yes | yes | USED |
| pdfkit | backend/deps | yes | yes | USED |
| pino | backend/deps | yes | yes | USED |
| pino-http | backend/deps | yes | yes | USED |
| playwright | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| postcss | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| qrcode | backend/deps | yes | yes | USED |
| react | root/deps | yes | yes | USED |
| react-dom | root/deps | yes | yes | USED |
| react-hook-form | root/deps | yes | yes | USED |
| recharts | root/deps | yes | yes | USED |
| sharp | backend/deps | yes | yes | USED |
| stream-json | backend/deps | yes | yes | USED |
| supertest | backend/devDeps | yes | yes | USED |
| tailwindcss | root/devDeps | yes | yes | DEV_DEAD: not used in tests/scripts |
| typescript | root/devDeps | yes | no | DEV_DEAD: not used in tests/scripts |
| ua-parser-js | backend/deps | yes | yes | USED |
| vite | root/devDeps | yes | yes | DEV_DEAD: not used in tests/scripts |
| vitest | backend/devDeps | yes | yes | DEV_DEAD: no usage in test files |
| xlsx | backend/deps | yes | yes | USED |
| zod | backend/deps | yes | yes | USED |
