# Single image: builds the React app and serves it from the API process.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* && npm ci
COPY . .
RUN npm run build -w web

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/server
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DB_PATH=/data/app.db STORAGE_DIR=/data PORT=4000
EXPOSE 4000
# tsx runs the TypeScript sources directly (keeps the image simple).
CMD ["npx", "tsx", "src/index.ts"]
