FROM mcr.microsoft.com/playwright:v1.65.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends php-cli && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/database.js ./server/database.js
COPY worker/ ./worker/
USER pwuser
CMD ["node","worker/index.js"]
