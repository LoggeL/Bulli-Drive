FROM node:22-alpine AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 8000
CMD ["node", "dist/server/index.js"]
