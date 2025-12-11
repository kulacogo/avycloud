# Root-level Dockerfile that builds the backend service.
# Cloud Run source deployments build from repo root; this ensures the backend is packaged.

FROM node:20-slim

WORKDIR /app

# Copy backend package files
COPY backend/package*.json ./

# Install production deps
RUN npm ci --only=production

# Copy backend source
COPY backend/. .

# Expose Cloud Run port
EXPOSE 8080

# Start backend
CMD ["npm", "start"]
