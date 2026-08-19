# Multi-stage Dockerfile for HelpMe Write Service
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json tsconfig.json ./
COPY prisma/ ./prisma/
RUN npm ci
RUN npx prisma generate

COPY src/ ./src/
RUN npm run build:server

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma/ ./prisma/
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

EXPOSE 8080

CMD ["node", "dist/services/write-server/index.js"]
