# Anvil

Pay-per-job execution and artifact service for AI agents, paid with [x402](https://github.com/x402-foundation/x402) on Algorand (USDC, GoPlausible facilitator).

Every paid call does real work and returns content-addressed artifacts. After settlement, the payment transaction id and the SHA-256 of the job manifest are anchored on Algorand in a 0-ALGO note transaction (`anvil/v1:j{"p":<payment txid>,"h":<manifest sha256>,"r":<route>}`), so anyone can check what was paid for with `GET /v1/verify/:txid`.

| Route | Price | What it does |
| --- | --- | --- |
| `POST /v1/evidence` | $0.35 | Notarized web evidence capture: loads a public URL in a real browser and returns a full-page screenshot, PDF, MHTML archive, DOM snapshot and clean markdown, all SHA-256 hashed and bound on Algorand to the payment. |
| `POST /v1/extract` | $0.10 | Schema-faithful document extraction: converts a PDF, DOCX, XLSX, PPTX, HTML or image (first 5 pages, OCR included) and returns JSON checked against your JSON Schema (a `valid` flag plus validation errors), with verbatim source quotes for extracted fields. |
| `POST /v1/extract/invoice` | $0.10 | Invoice / receipt to accounting-ready JSON (vendor, customer, dates, line items, tax, totals, bank details) with verbatim evidence per field and arithmetic checks (line items vs subtotal, subtotal + tax vs total). |
| `POST /v1/extract/bank-statement` | $0.35 | Bank statement to categorised transaction ledger (signed amounts, running balances, categories) with a reconciliation check: opening balance + sum(transactions) must equal closing balance. |
| `POST /v1/extract/resume-match` | $0.25 | Resume vs job description screening: scores the candidate requirement-by-requirement (met / partial / not met) with verbatim resume quotes checked against the source, plus strengths, gaps and interview questions. |
| `POST /v1/compare` | $0.25 | Semantic document comparison (contracts, policies, terms, specs): converts two versions and returns a list of material changes (added / removed / modified) with verbatim before/after quotes verified against each version and a risk-oriented significance rating. |
| `POST /v1/run` | $0.05 | Isolated code execution: runs Python (pandas, numpy, scipy, matplotlib preinstalled) or JavaScript (Node.js) in a fresh Vercel Sandbox Firecracker microVM with no network and no state shared between calls, and returns stdout, stderr, exit code and every file written to ./output (charts, CSVs) as hashed artifacts. |
| `POST /v1/analyze` | $0.10 | Data analysis as a call: send a CSV/TSV/JSON/Parquet/Excel dataset and a question; Gemini writes pandas/matplotlib code, it runs in a fresh Vercel Sandbox Firecracker microVM with no network (with one self-repair attempt), and you get the answer, the exact code, charts and transformed files as hashed artifacts. |
| `POST /v1/test` | $0.25 | CI-as-a-call: clones a public git repository (GitHub, GitLab, Bitbucket, Codeberg) at an exact commit/branch/tag inside a fresh Vercel Sandbox Firecracker microVM, installs dependencies, runs its test suite (auto-detected for Node, Python, Go or Rust, or your command) and returns pass/fail, the resolved commit SHA, JUnit XML when the suite emits it (auto-detected for pytest), and full logs as hashed evidence. |
| `POST /v1/audit/site` | $0.50 | Website audit report: Lighthouse performance/accessibility/best-practices/SEO scores, axe-core WCAG 2.2 AA violations with offending selectors, on-page SEO checks (title, meta, headings, alt text, canonical, robots, sitemap) and a full-page screenshot, delivered as a PDF report plus JSON. |
| `POST /v1/research/brief` | $0.75 | Cited research brief / due-diligence dossier: Gemini with live Google Search grounding writes a structured brief where every claim carries numbered citations; the top cited source pages (up to 10) are snapshotted and SHA-256 hashed so the evidence survives link rot. |
| `POST /v1/browse/act` | $0.25 | Scripted browser session: runs up to 25 steps (goto, click, fill, select, press, wait_for, scroll, extract, screenshot) in a real Chromium on public sites and returns extracted values, per-step results, screenshots and a Playwright trace as hashed evidence. |
| `POST /v1/monitor` | $0.50 | Evidence-grade change monitoring: watches a public page (or one CSS selector) for up to 24 checks at your interval; every change is captured (screenshot + text), diffed, SHA-256 hashed, anchored on Algorand and pushed to your webhook with an Ed25519 signature. |
| `POST /v1/certify` | $0.25 | Issues a verifiable certificate PDF (completion, membership, authenticity, award): rendered, SHA-256 hashed, Ed25519-signed by Anvil's Algorand receipt key and anchored on-chain; anyone can verify the PDF hash via GET /v1/verify/hash/{sha256}. |
| `POST /v1/attest` | $0.10 | Timestamped proof-of-existence: binds a SHA-256 (or content you send) plus a label and metadata to an Algorand transaction. |
| `GET /v1/verify/:txid` | free | Recomputes the manifest hash and checks the on-chain anchor |
| `GET /v1/verify/hash/:sha256` | free | Finds every Anvil job (attestation, certificate, artifact) that recorded this SHA-256 |
| `GET /v1/monitor/:id` | free | Monitor status, change history and evidence links |
| `POST /mcp` | per tool | MCP Streamable HTTP endpoint exposing every paid route as a tool, paid with x402 (`@x402/mcp`) under the same `payTo` |

Each paid route advertises Bazaar discovery metadata and `extra.tag = "x402-global-challenge"`, all under one `payTo`.

## Stack

Hono + `@x402/hono` / `@x402/avm` / `@x402/extensions` / `@x402/mcp` 2.27, MCP TypeScript SDK, Playwright (remote browser) + axe-core, Google PageSpeed Insights, docling-serve, Gotenberg, Gemini structured output + AJV, Vercel Sandbox microVMs, any S3-compatible store (Cloudflare R2 in production), algosdk.

## Run locally

Requires Node 24, pnpm 12, Docker.

```sh
pnpm install
docker compose --profile dev up -d          # browser, docling-serve, gotenberg, local S3 (versitygw)
cp .env.example .env.local                   # fill in what you have
pnpm dev
```

Without `PAY_TO` the routes run unpaid (development only). Integrations are optional until used; calling a route without its key returns a clear error:

- `GEMINI_API_KEY`: `/v1/extract*`, `/v1/compare`, `/v1/research/brief`, `/v1/analyze`. `GEMINI_MODEL` / `GEMINI_SEARCH_MODEL` take comma-separated fallbacks used on 429/5xx; free-tier keys only get Search grounding on 2.5 models
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_SANDBOX_SNAPSHOT`: `/v1/run`, `/v1/analyze`, `/v1/test` run in [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) Firecracker microVMs (free Hobby plan: 5 active-CPU hours and 5,000 sandboxes a month, no card). Run `pnpm sandbox:snapshot` once to build the snapshot (Python data stack, Node 24, Go, Rust) and set the printed id
- `RECEIPT_MNEMONIC`: `/v1/certify` signatures and all on-chain anchors
- `PAGESPEED_API_KEY` (optional): Lighthouse scores in `/v1/audit/site`; the unauthenticated quota is often exhausted, pass `"lighthouse": false` to skip

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm smoke         # unpaid run of every key-free route against the compose sidecars (attest, certify, evidence, audit, browse, monitor, MCP)
pnpm live:sandbox  # real run of /v1/run, /v1/analyze, /v1/test in Vercel Sandbox microVMs
pnpm live:gemini   # real Gemini run of /v1/extract*, /v1/compare, /v1/research/brief (needs GEMINI_API_KEY)
pnpm e2e:localnet   # full paid flow on AlgoKit LocalNet (`algokit localnet start`)
pnpm testnet:setup  # Testnet: top up payTo/receipt accounts from the payer, USDC opt-ins (.env.testnet)
pnpm live:testnet   # every route paid for real through GoPlausible on Testnet, receipts verified
```

`e2e:localnet` creates a local USDC-like ASA, runs an in-process x402 facilitator, and asserts: 402 challenge (price, tag, Bazaar), no charge on invalid input, paid 200 with artifacts, `payTo` balance +0.35 USDC, a verified on-chain receipt, and a paid MCP tool call (`attest`, +0.10 USDC) with its own verified receipt.

## Network ids

GoPlausible advertises Algorand networks with the full genesis hash (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` for Mainnet), whereas `@x402/avm` 2.27 constants use the 32-character form. Anvil uses the facilitator's form; the SDK normalizes both.

## Production

See `deploy/DEPLOY.md` for the tested bare-metal layout (systemd units, nginx + certbot) and `Dockerfile` / `compose.yaml` for the reference container path.

Set `ALGORAND_NETWORK=mainnet`, `PAY_TO` (opted in to USDC ASA 31566704), `PUBLIC_URL` (your public HTTPS root — the process refuses to boot on mainnet with a localhost URL), `RECEIPT_MNEMONIC` (hot wallet with a few ALGO for anchor fees), S3/R2 (`STORAGE_CAP_BYTES` caps total bucket size; new jobs get an unpaid 503 near the cap), Gemini key, plus the sandbox setup above on the host. `FACILITATOR_URL` defaults to `https://facilitator.goplausible.xyz`. Request bodies, per-artifact bytes and concurrent job/sandbox/browser execution are bounded (`MAX_BODY_BYTES`, `MAX_ARTIFACT_BYTES`, `JOB_CONCURRENCY`, `SANDBOX_CONCURRENCY`, `BROWSER_CONCURRENCY`). Run exactly one instance: the /v1/monitor scheduler is in-process and would duplicate checks across replicas. SIGTERM/SIGINT drain in-flight requests before exit.
