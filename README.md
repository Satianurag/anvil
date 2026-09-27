# Anvil

Pay-per-job execution and artifact service for AI agents, paid with [x402](https://github.com/x402-foundation/x402) on Algorand (USDC, GoPlausible facilitator).

Every paid call does real work and returns content-addressed artifacts. After settlement, the payment transaction id and the SHA-256 of the job manifest are anchored on Algorand in a 0-ALGO note transaction (`anvil/v1:j{"p":<payment txid>,"h":<manifest sha256>,"r":<route>}`), so anyone can check what was paid for with `GET /v1/verify/:txid`.

| Route | Price | What it does |
| --- | --- | --- |
| `POST /v1/evidence` | $0.35 | Loads a public URL in a real browser; returns full-page PNG, PDF, MHTML, DOM and clean Markdown plus HTTP/TLS metadata, all hashed |
| `POST /v1/extract` | $0.10 | Document (URL or base64, ≤5 pages) → JSON matching your JSON Schema, with verbatim evidence quotes checked against the source |
| `POST /v1/run` | $0.05 | Runs Python/JavaScript in a fresh E2B sandbox; returns stdout/stderr/results and generated charts |
| `GET /v1/verify/:txid` | free | Recomputes the manifest hash and checks the on-chain anchor |

Each paid route advertises Bazaar discovery metadata and `extra.tag = "x402-global-challenge"`, all under one `payTo`.

## Stack

Hono + `@x402/hono` / `@x402/avm` / `@x402/extensions` 2.27, Playwright (remote browser), docling-serve, Gemini structured output + AJV, E2B, any S3-compatible store (Cloudflare R2 in production), algosdk.

## Run locally

Requires Node 24, pnpm 12, Docker.

```sh
pnpm install
docker compose --profile dev up -d          # browser, docling-serve, local S3 (versitygw)
cp .env.example .env.local                   # fill in what you have
pnpm dev
```

Without `PAY_TO` the routes run unpaid (development only). Integrations are optional until used: `/v1/extract` needs `GEMINI_API_KEY`, `/v1/run` needs `E2B_API_KEY`; calling them without one returns a clear error.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm e2e:localnet   # full paid flow on AlgoKit LocalNet (`algokit localnet start`)
```

`e2e:localnet` creates a local USDC-like ASA, runs an in-process x402 facilitator, and asserts: 402 challenge (price, tag, Bazaar), no charge on invalid input, paid 200 with artifacts, `payTo` balance +0.35 USDC, and a verified on-chain receipt.

## Network ids

GoPlausible advertises Algorand networks with the full genesis hash (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` for Mainnet), whereas `@x402/avm` 2.27 constants use the 32-character form. Anvil uses the facilitator's form; the SDK normalizes both.

## Production

Set `ALGORAND_NETWORK=mainnet`, `PAY_TO` (opted in to USDC ASA 31566704), `PUBLIC_URL`, `RECEIPT_MNEMONIC` (hot wallet with a few ALGO for anchor fees), S3/R2, Gemini and E2B keys. `FACILITATOR_URL` defaults to `https://facilitator.goplausible.xyz`.
