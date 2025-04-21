FROM node:18-slim

# Install FFmpeg and canvas dependencies
RUN apt-get update && \
    apt-get install -y ffmpeg \
    build-essential \
    python3 \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy both package.json AND package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Bundle app source
COPY . .

# Create directory for logs
RUN mkdir -p logs && chown -R node:node logs

# Switch to non-root user
USER node

# Start the application
CMD ["node", "app.js"]
