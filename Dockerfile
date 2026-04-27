FROM ubuntu:latest

ARG DEBIAN_FRONTEND=noninteractive
ARG BUILD_NODE_OPTIONS=--max-old-space-size=6144

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl gh git openssh-client ripgrep xz-utils \
  && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV MISE_DATA_DIR=/mise
ENV MISE_CONFIG_DIR=/mise
ENV MISE_CACHE_DIR=/mise/cache
ENV MISE_INSTALL_PATH=/usr/local/bin/mise
ENV PATH=/mise/shims:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN curl -fsSL https://mise.run | sh

WORKDIR /app

COPY docker/mise.toml /mise/config.toml
RUN mise trust -a \
  && mise install \
  && mise reshim

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
COPY docker/mise.toml /app/.mise.toml
RUN mise trust /app/.mise.toml \
  && NODE_OPTIONS="${BUILD_NODE_OPTIONS}" pnpm build

ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
ENV CORAZON_ROOT_DIR=/root/.corazon
ENV CODEX_HOME=/root/.corazon
ENV CORAZON_RUNTIME_ROOT_DIR=/root/.corazon-runtime
ENV CORAZON_THREADS_DIR=/root/.corazon-runtime/threads
ENV WORKFLOW_LOCAL_DATA_DIR=/root/.corazon-runtime/workflow-data

COPY scripts/docker-entrypoint.sh /usr/local/bin/corazon-entrypoint
RUN chmod +x /usr/local/bin/corazon-entrypoint

EXPOSE 3000
VOLUME ["/root/.corazon", "/root/.corazon-runtime", "/root/.ssh"]

ENTRYPOINT ["corazon-entrypoint"]
CMD ["node", "scripts/start-server.mjs"]
