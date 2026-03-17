FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client make g++ ripgrep xz-utils \
  && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV MISE_DATA_DIR=/mise
ENV MISE_CONFIG_DIR=/mise
ENV MISE_CACHE_DIR=/mise/cache
ENV MISE_INSTALL_PATH=/usr/local/bin/mise
ENV PATH=/mise/shims:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

COPY .mise.toml /mise/config.toml
RUN curl https://mise.run | sh \
  && mise trust /mise/config.toml \
  && mise install \
  && mise reshim

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
VOLUME ["/root/.corazon", "/root/.ssh"]

ENTRYPOINT ["corazon-entrypoint"]
CMD ["node", ".output/server/index.mjs"]
