# Runs only the Node endpoint; the wasm is the committed, hash-pinned build in dist/.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY dist ./dist
ENV NODE_ENV=production
USER node
CMD ["node", "server/index.js"]
