FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY scripts/vendor.js ./scripts/vendor.js
RUN npm ci --omit=dev
COPY server.js auth.js media.js combined-video.js official-video.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.js"]
