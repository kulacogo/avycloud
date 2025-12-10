
# Use official Node.js LTS image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files (build context = backend/)
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy source
COPY . .

# Expose port (Cloud Run uses PORT env variable)
EXPOSE 8080

# Start backend
CMD ["npm", "start"]
