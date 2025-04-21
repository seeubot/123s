FROM node:16-slim

# Install required dependencies for ffmpeg
RUN apt-get update && apt-get install -y \
    ca-certificates \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy the rest of the application
COPY . .

# Create temp directory for thumbnails
RUN mkdir -p /tmp/telegram-thumbnails && chmod 777 /tmp/telegram-thumbnails

# Start the application
CMD ["npm", "start"]
