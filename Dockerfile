# Stage 1: Runtime Environment
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy backend dependencies
COPY backend/node-server/package*.json ./
RUN npm install --production

# Copy Python requirements and install
COPY backend/requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Copy backend source code
COPY backend/node-server/src ./src
COPY backend/fix_audio.py ./

# Copy built Angular Admin assets
# Ensure 'backend/static' contains the production build of angular-admin
COPY backend/static ./static

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5001
ENV MEDIA_PATH=/app/videos
ENV STATIC_PATH=/app/static/browser
# On Linux, we use the system-installed ffmpeg
ENV FFMPEG_BIN=/usr/bin/ffmpeg
ENV FFPROBE_BIN=/usr/bin/ffprobe

# Expose the backend port
EXPOSE 5001

# Start the server
CMD ["node", "src/index.js"]
