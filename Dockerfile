FROM node:20-slim

# Install FFmpeg and required tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version 2>&1 | head -1

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy app
COPY server.js ./

# Create tmp dir
RUN mkdir -p /tmp/renders

# Railway uses $PORT env var — expose the default
EXPOSE 3000

# Start
CMD ["node", "server.js"]
