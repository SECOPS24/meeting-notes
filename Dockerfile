FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# Install dependencies, then remove npm, corepack and yarn: the app does not need
# them at runtime, and their bundled packages are what the vulnerability scan flags.
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /root/.npm

COPY server.js ./
COPY public ./public

# The app writes its JSON data file here; it must be writable by the non-root user.
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "server.js"]
