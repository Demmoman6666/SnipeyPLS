# Railway-friendly Dockerfile (no VOLUME directive)
FROM node:20-alpine

WORKDIR /app

# Install deps (include dev deps so TypeScript can build)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Optionally prune dev deps for smaller image (safe to skip)
RUN npm prune --omit=dev || true

ENV NODE_ENV=production
# Railway injects env vars automatically; no --env-file needed
CMD ["node", "dist/index.js"]
