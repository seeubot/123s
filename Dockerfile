FROM node:16-slim

WORKDIR /app

# Install only the necessary ffmpeg dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the port
EXPOSE 8000

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["node", "main.js"]
