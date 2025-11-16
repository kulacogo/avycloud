
# Use official Node.js LTS image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
# npm ci is faster and more reliable for production builds
RUN npm ci --only=production

# Copy application files
COPY . .

# Expose port (Cloud Run uses PORT env variable)
EXPOSE 8080

# Use npm start for better compatibility
CMD ["npm", "start"]
