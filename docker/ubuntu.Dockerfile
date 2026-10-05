# Image de test : vérifie l'installation et les tests sous Ubuntu 24.04.
#   docker build -f docker/ubuntu.Dockerfile -t docs-search-ubuntu .
#   docker run --rm docs-search-ubuntu
FROM ubuntu:24.04

ARG NODE_VERSION=24.14.1
# Le corepack livré avec Node peut être trop ancien pour pnpm 12 (et Node 25+ n'en livre plus).
ARG COREPACK_VERSION=0.36.0

# ripgrep (apt), Node officiel (tarball vérifié par SHASUMS256), utilisateur non root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils ripgrep \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "arch $arch non gérée"; exit 1 ;; esac; \
    f="node-v${NODE_VERSION}-linux-${a}.tar.xz"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${f}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "$f" SHASUMS256.txt; \
    npm install -g --ignore-scripts "corepack@${COREPACK_VERSION}"; \
    corepack enable

RUN useradd --create-home app
USER app
WORKDIR /home/app/docs-search

# corepack télécharge le pnpm de packageManager et vérifie son hash.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --chown=app package.json pnpm-lock.yaml pnpm-workspace.yaml .nvmrc ./
COPY --chown=app scripts ./scripts
RUN pnpm install --frozen-lockfile

COPY --chown=app tsconfig.json ./
COPY --chown=app src ./src

CMD ["sh", "-c", "node --version && rg --version | head -1 && pnpm typecheck && pnpm test"]
