FROM node:18-slim

# Install FFmpeg and build essentials (for potential native module compilation)
RUN apt-get update && \
    apt-get install -y ffmpeg build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy both package.json AND package-lock.json
COPY package*.json ./

# Try regular npm install first, which is more forgiving
RUN npm install --production

# Bundle app source
COPY . .

# Create directory for logs
RUN mkdir -p logs && chown -R node:node logs

# Switch to non-root user
USER node

# Start the application
CMD ["node", "app.js"]
