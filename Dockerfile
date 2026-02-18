FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
ENV CORAZON_ROOT_DIR=/root/.corazon
ENV CODEX_HOME=/root/.corazon
ENV WORKFLOW_LOCAL_DATA_DIR=/root/.corazon/workflow-data

COPY scripts/docker-entrypoint.sh /usr/local/bin/corazon-entrypoint
RUN chmod +x /usr/local/bin/corazon-entrypoint

EXPOSE 3000
VOLUME ["/root/.corazon"]

ENTRYPOINT ["corazon-entrypoint"]
CMD ["node", ".output/server/index.mjs"]
