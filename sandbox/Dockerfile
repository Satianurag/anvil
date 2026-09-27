# Execution image for /v1/run, /v1/analyze and /v1/test (run under gVisor, see src/lib/sandbox.ts).
FROM node:24.21.0-trixie
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv python-is-python3 coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --break-system-packages \
    pandas numpy scipy matplotlib seaborn pyarrow openpyxl xlrd pytest \
 && corepack enable \
 && mkdir -p /work && chown node:node /work
ENV MPLBACKEND=Agg PIP_BREAK_SYSTEM_PACKAGES=1 PYTHONUNBUFFERED=1
USER node
WORKDIR /work
