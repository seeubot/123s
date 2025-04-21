FROM node:18-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Create directory for logs
RUN mkdir -p logs && chown -R node:node logs

# Switch to non-root user
USER node

# Start the application
CMD ["node", "app.js"]
