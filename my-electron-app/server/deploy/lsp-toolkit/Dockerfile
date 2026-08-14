ARG BASE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${BASE_IMAGE} AS downloads
ARG RUST_ANALYZER_VERSION=2026-08-10.1
ARG RUST_ANALYZER_SHA256=d42908a7dc7b89250ae881a0919e477296843665c98574ecc8fe16ba60cecefb
ARG JRE_VERSION=21.0.12_8
ARG JRE_SHA256=8a379a67c91a3ae61ffb33d46e0a40c7ba35e70713c4db31cfca30492f792eff
ARG JDTLS_VERSION=1.60.0
ARG JDTLS_BUILD=202606262232
ARG JDTLS_SHA256=e94c303d8198f977930803582738771fd18c52c5492878410bf222b1aa81ef1d
COPY downloads/ /tmp/vendor/
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gzip tar; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /out/usr/local/bin /out/opt/java /out/opt/jdtls; \
    fetch() { \
      filename="$1"; url="$2"; destination="$3"; \
      if [ -s "/tmp/vendor/${filename}" ]; then \
        cp "/tmp/vendor/${filename}" "$destination"; \
      else \
        curl -fL --retry 5 --retry-all-errors "$url" -o "$destination"; \
      fi; \
    }; \
    fetch rust-analyzer-x86_64-unknown-linux-gnu.gz \
      "https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_VERSION}/rust-analyzer-x86_64-unknown-linux-gnu.gz" \
      /tmp/rust-analyzer.gz; \
    echo "${RUST_ANALYZER_SHA256}  /tmp/rust-analyzer.gz" | sha256sum -c -; \
    gzip -dc /tmp/rust-analyzer.gz > /out/usr/local/bin/rust-analyzer; \
    chmod 0755 /out/usr/local/bin/rust-analyzer; \
    fetch OpenJDK21U-jre_x64_linux_hotspot_${JRE_VERSION}.tar.gz \
      "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jre_x64_linux_hotspot_${JRE_VERSION}.tar.gz" \
      /tmp/jre.tar.gz; \
    echo "${JRE_SHA256}  /tmp/jre.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jre.tar.gz -C /out/opt/java --strip-components=1; \
    fetch jdt-language-server-${JDTLS_VERSION}-${JDTLS_BUILD}.tar.gz \
      "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}-${JDTLS_BUILD}.tar.gz" \
      /tmp/jdtls.tar.gz; \
    echo "${JDTLS_SHA256}  /tmp/jdtls.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jdtls.tar.gz -C /out/opt/jdtls

FROM ${BASE_IMAGE} AS gopls-builder
ARG GO_VERSION=1.26.5
ARG GO_SHA256=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053
ARG GOPLS_VERSION=v0.23.0
ARG GO_PROXY=https://proxy.golang.org,direct
COPY downloads/ /tmp/vendor/
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    if [ -s "/tmp/vendor/go${GO_VERSION}.linux-amd64.tar.gz" ]; then \
      cp "/tmp/vendor/go${GO_VERSION}.linux-amd64.tar.gz" /tmp/go.tar.gz; \
    else \
      curl -fL --retry 5 --retry-all-errors \
        "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz; \
    fi; \
    echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/go /out; \
    tar -xzf /tmp/go.tar.gz -C /opt/go --strip-components=1; \
    GOPROXY="$GO_PROXY" GOBIN=/out CGO_ENABLED=0 /opt/go/bin/go install -trimpath -ldflags='-s -w' "golang.org/x/tools/gopls@${GOPLS_VERSION}"; \
    rm -rf /root/go /root/.cache /tmp/go.tar.gz

FROM ${BASE_IMAGE} AS rust-toolchain
ARG RUST_VERSION=1.97.1
ARG RUST_DATE=2026-07-16
ARG RUSTC_SHA256=9819d0a32d56bd339585319c80260e332779f5541fd66838ab7e016d6c814819
ARG CARGO_SHA256=e1be5f5ff7f7f80ca506fb65770b759edbdc6d303781ed71c5de8ec8a8394779
ARG RUST_STD_SHA256=1c1e704ae80126b7de34f72ea2825f7fd01736dec20732faed47374b95282fba
ARG RUST_SRC_SHA256=e9a1e616d04c6845895c827a178b9227f7c7199f3f4a80af81ab3aff7b80156b
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /out/opt/rust /tmp/rust-components; \
    install_component() { \
      name="$1"; archive="$2"; checksum="$3"; \
      curl -fL --retry 5 --retry-all-errors \
        "https://static.rust-lang.org/dist/${RUST_DATE}/${archive}" -o "/tmp/${archive}"; \
      echo "${checksum}  /tmp/${archive}" | sha256sum -c -; \
      component_dir="/tmp/rust-components/${name}"; \
      mkdir -p "$component_dir"; \
      tar -xJf "/tmp/${archive}" -C "$component_dir" --strip-components=1; \
      "$component_dir/install.sh" --prefix=/out/opt/rust --disable-ldconfig; \
      rm -rf "$component_dir" "/tmp/${archive}"; \
    }; \
    install_component rustc "rustc-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz" "$RUSTC_SHA256"; \
    install_component cargo "cargo-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz" "$CARGO_SHA256"; \
    install_component rust-std "rust-std-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz" "$RUST_STD_SHA256"; \
    install_component rust-src "rust-src-${RUST_VERSION}.tar.xz" "$RUST_SRC_SHA256"; \
    rm -rf /tmp/rust-components

FROM ${BASE_IMAGE} AS node-tools
WORKDIR /opt/node-lsp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${BASE_IMAGE}
ARG TOOLKIT_VERSION=2026.08.11.2
ARG CLANGD_PACKAGE_VERSION=1:19.1.7-3~deb12u1
LABEL org.opencontainers.image.title="BOBOCloud LSP Toolkit" \
      org.opencontainers.image.version="${TOOLKIT_VERSION}" \
      org.opencontainers.image.description="Pinned language servers for application, web, configuration and shell languages"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      gcc \
      g++ \
      git \
      python3 \
      libc6-dev \
      libstdc++-12-dev \
      "clangd-19=${CLANGD_PACKAGE_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /analysis-cache /opt/bobocloud; \
    ln -s /usr/bin/clangd-19 /usr/local/bin/clangd

COPY --from=downloads /out/ /
COPY --from=gopls-builder /out/gopls /usr/local/bin/gopls
COPY --from=gopls-builder /opt/go /opt/go
COPY --from=rust-toolchain /out/opt/rust /opt/rust
COPY --from=node-tools /opt/node-lsp /opt/node-lsp
COPY --chmod=0755 jdtls.sh /usr/local/bin/jdtls
COPY --chmod=0755 clangd.sh /usr/local/bin/bobocloud-clangd
COPY --chmod=0755 pyright-python.sh /usr/local/bin/bobocloud-python
COPY prepare-clangd-cdb.js /opt/bobocloud/prepare-clangd-cdb.js
COPY clangd-flags.js /opt/bobocloud/clangd-flags.js
COPY --chmod=0755 verify.sh /usr/local/bin/bobocloud-lsp-verify
COPY --chmod=0755 lsp-smoke.js /usr/local/bin/bobocloud-lsp-smoke

ENV JAVA_HOME=/opt/java \
    GOROOT=/opt/go \
    RUST_SRC_PATH=/opt/rust/lib/rustlib/src/rust/library \
    NODE_PATH=/opt/node-lsp/node_modules \
    NODE_OPTIONS=--max-old-space-size=384 \
    GOMEMLIMIT=400MiB \
    PATH=/opt/java/bin:/opt/go/bin:/opt/rust/bin:/opt/node-lsp/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace
HEALTHCHECK NONE
CMD ["bobocloud-lsp-verify"]
