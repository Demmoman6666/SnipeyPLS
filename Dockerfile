# Lightweight Node build for long-running bot
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN npm install --omit=dev || true

COPY . .
RUN npm run build

# Persist SQLite data if you mount a volume to /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
CMD ["node","--env-file=.env","dist/index.js"]
