/** One-time: builds the `anvil-sandbox` Daytona snapshot used by /v1/run, /v1/analyze and /v1/test. */
import { Daytona, Image } from "@daytona/sdk";

const name = process.env.DAYTONA_SNAPSHOT ?? "anvil-sandbox";
const image = Image.base("node:24.21.0-trixie")
  .runCommands(
    "apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv python-is-python3 git && rm -rf /var/lib/apt/lists/*",
    "pip install --no-cache-dir --break-system-packages pandas numpy scipy matplotlib seaborn pyarrow openpyxl xlrd pytest",
    "curl -fsSL https://go.dev/dl/$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1).linux-amd64.tar.gz | tar -C /usr/local -xz",
    "curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path",
    "corepack enable && mkdir -p /work && chmod -R a+rwX /work /usr/local/cargo /usr/local/rustup",
  )
  .env({
    PATH: "/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    RUSTUP_HOME: "/usr/local/rustup",
    CARGO_HOME: "/usr/local/cargo",
    GOPATH: "/tmp/go",
    GOCACHE: "/tmp/go-cache",
    MPLBACKEND: "Agg",
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    PYTHONUNBUFFERED: "1",
  })
  .workdir("/work");

const daytona = new Daytona();
const existing = await daytona.snapshot.get(name).catch(() => undefined);
if (existing) await daytona.snapshot.delete(existing);
const snap = await daytona.snapshot.create(
  { name, image, resources: { cpu: 2, memory: 4, disk: 8 } },
  { onLogs: (l) => process.stdout.write(l), timeout: 0 },
);
console.log(`\nsnapshot ${snap.name} ${snap.state}`);
