# Use multi-stage build for more efficiency
FROM node:16-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json ./

# Install all dependencies (including dev dependencies)
RUN npm install

# Use lean production image
FROM node:16-slim

# Install required dependencies for ffmpeg
RUN apt-get update && apt-get install -y \
    ca-certificates \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and installed node modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy source code
COPY . .

# Create temp directory for thumbnails
RUN mkdir -p /tmp/telegram-thumbnails && chmod 777 /tmp/telegram-thumbnails

# Start the application
CMD ["node", "botMain.js"]
