# Execution image for /v1/run, /v1/analyze and /v1/test (run under gVisor, see src/lib/sandbox.ts).
FROM golang:trixie AS go
FROM rust:trixie AS rust
FROM node:24.21.0-trixie
COPY --from=go /usr/local/go /usr/local/go
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv python-is-python3 coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --break-system-packages \
    pandas numpy scipy matplotlib seaborn pyarrow openpyxl xlrd pytest \
 && corepack enable \
 && mkdir -p /work && chown node:node /work && chown -R node:node /usr/local/cargo
ENV PATH=/usr/local/go/bin:/usr/local/cargo/bin:$PATH RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo GOPATH=/tmp/go GOCACHE=/tmp/go-cache GOTOOLCHAIN=local \
    MPLBACKEND=Agg PIP_BREAK_SYSTEM_PACKAGES=1 PYTHONUNBUFFERED=1
USER node
WORKDIR /work
