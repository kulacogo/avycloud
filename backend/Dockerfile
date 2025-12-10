
# Use official Node.js LTS image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy backend package files (works whether build context is repo root or backend/)
COPY backend/package*.json ./ 

# Install production dependencies
RUN npm ci --only=production

# Copy backend source
COPY backend/. .

# Expose port (Cloud Run uses PORT env variable)
EXPOSE 8080

# Start backend
CMD ["npm", "start"]
