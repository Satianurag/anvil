# Deploying anvil

Two tested paths. Both run the same env-driven sidecar contract — nothing is hardcoded.

## A. Bare metal (what we run)

Ubuntu 24.04, ~1 GB RAM class VM. Footprint: nginx, Node 24, one systemd unit per process, Cloudflare R2 for storage. No containers.

### 1. Packages

```bash
sudo apt-get update
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx python3-venv
# Node 24 via NodeSource:  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
```

### 2. App

```bash
git clone https://github.com/Satianurag/anvil ~/anvil && cd ~/anvil
corepack enable && pnpm install --frozen-lockfile
npx playwright install --with-deps chromium   # browser binaries + libs for run-server
cp .env.example .env   # fill in (below)
```

### 3. Docling (document conversion)

```bash
python3 -m venv ~/docling-venv
~/docling-venv/bin/pip install docling-serve[ui]
# First run downloads ~500 MB of models — let it finish once before enabling the unit.
```

### 4. Storage

Point `S3_*` at real Cloudflare R2 (endpoint `https://<acct>.r2.cloudflarestorage.com`, region `auto`). Storage is shared infra; keep it off-box.

### 5. Env (`/home/ubuntu/anvil/.env`)

```
PUBLIC_URL=https://anvil.satimon.com
ALGORAND_NETWORK=mainnet
PAY_TO=<mainnet address opted in to USDC ASA 31566704>
RECEIPT_MNEMONIC=<hot wallet, a few ALGO>
S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=anvil
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
GEMINI_API_KEY=...
VERCEL_TOKEN=...
VERCEL_TEAM_ID=...
VERCEL_PROJECT_ID=...
VERCEL_SANDBOX_SNAPSHOT=...
BROWSER_WS_URL=ws://localhost:3001/
DOCLING_URL=http://localhost:5001
# Leave GOTENBERG_URL unset — the shared browser renders PDFs natively.
```

### 6. systemd

```bash
sudo cp deploy/anvil.service deploy/anvil-browser.service deploy/anvil-docling.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anvil-browser anvil-docling anvil
systemctl status anvil --no-pager
journalctl -u anvil -f
```

### 7. TLS

```bash
sudo cp deploy/nginx-anvil.conf /etc/nginx/sites-available/anvil
# edit server_name to your domain
sudo ln -s /etc/nginx/sites-available/anvil /etc/nginx/sites-enabled/anvil
sudo certbot --nginx -d anvil.satimon.com
sudo nginx -t && sudo systemctl reload nginx
```

### 8. Verify

```bash
curl -s https://your-domain/healthz | jq .
ALGORAND_NETWORK=mainnet pnpm smoke          # unpaid prechecks against the live API
LIVE_BASE_URL=https://your-domain LIVE_PAYER_MNEMONIC=... pnpm live:testnet
```

## B. Reference containers

`Dockerfile` (app) + `compose.yaml` (`--profile dev`: browser, docling, gotenberg, versitygw S3):

```bash
docker build -t anvil .
docker run --env-file .env -p 4021:4021 anvil
# or the whole dev stack:
docker compose --profile dev up -d
docker compose --profile dev run app pnpm smoke
```

## Operational notes

- Run **exactly one** app instance: the `/v1/monitor` scheduler is in-process; replicas duplicate checks.
- `SIGTERM` drains in-flight requests for up to ~15 s (`systemctl restart` is safe).
- Concurrency is bounded (`JOB_CONCURRENCY` 4, `SANDBOX_CONCURRENCY` 2, `BROWSER_CONCURRENCY` 4) — raise only if Vercel Sandbox quota and RAM allow.
- Artifact URLs are pre-signed (`ARTIFACT_URL_TTL_SECONDS`, default 7 days); set it to the evidence-retention window you promise.
- `STORAGE_CAP_BYTES` keeps the bucket inside its quota; near the cap new jobs get an unpaid 503.
- Mainnet boot fails fast if `PUBLIC_URL` is localhost — caught by the config guard, not by 402s at runtime.
