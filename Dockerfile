# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# --ignore-scripts: the postinstall hook would download the browser without its system libraries.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY bin ./bin
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && useradd --system --create-home --shell /usr/sbin/nologin app \
 && mkdir -p /var/data && chown -R app:app /var/data /app

EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "bin/http.js"]
