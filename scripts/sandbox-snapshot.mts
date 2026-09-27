/** One-time: builds the Vercel Sandbox snapshot used by /v1/run, /v1/analyze and /v1/test; prints its id. */
import { Sandbox } from "@vercel/sandbox";

const creds = {
  token: process.env.VERCEL_TOKEN ?? "",
  teamId: process.env.VERCEL_TEAM_ID ?? "",
  projectId: process.env.VERCEL_PROJECT_ID ?? "",
};
const sbx = await Sandbox.create({
  ...creds,
  image: "vercel/sandbox/universal",
  persistent: false,
  resources: { vcpus: 4 },
  timeout: 30 * 60_000,
});
const steps = [
  "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential pkg-config libssl-dev && sudo rm -rf /var/lib/apt/lists/*",
  "sudo mkdir -p /work && sudo chown $(id -u):$(id -g) /work",
  "python3 -m pip install --user --break-system-packages -q pandas numpy scipy matplotlib seaborn pyarrow openpyxl xlrd pytest",
  "curl -fsSL https://go.dev/dl/$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1).linux-amd64.tar.gz | sudo tar -C /usr/local -xz && sudo ln -sf /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/",
  "curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal && sudo ln -sf $HOME/.cargo/bin/* /usr/local/bin/",
  "mkdir -p ~/.config/matplotlib && echo 'backend: Agg' > ~/.config/matplotlib/matplotlibrc",
  "python3 -c 'import pandas, matplotlib' && node --version && go version && cargo --version",
];
for (const cmd of steps) {
  const r = await sbx.runCommand({ cmd: "bash", args: ["-lc", cmd], stdout: process.stdout, stderr: process.stderr });
  if (r.exitCode !== 0) throw new Error(`step failed (${r.exitCode}): ${cmd}`);
}
const snap = await sbx.snapshot({ expiration: 0 });
console.log(`\nVERCEL_SANDBOX_SNAPSHOT=${snap.snapshotId}`);
