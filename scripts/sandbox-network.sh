#!/usr/bin/env bash
# Egress-only Docker network for /v1/test: public internet yes; host, private ranges and cloud metadata no.
set -euo pipefail
NET=${SANDBOX_NETWORK:-anvil-egress}
SUBNET=${SANDBOX_SUBNET:-172.31.250.0/24}
docker network inspect "$NET" >/dev/null 2>&1 ||
  docker network create --subnet "$SUBNET" -o com.docker.network.bridge.name="$NET" "$NET"
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4; do
  iptables -C DOCKER-USER -s "$SUBNET" -d "$dst" -j DROP 2>/dev/null ||
    iptables -I DOCKER-USER -s "$SUBNET" -d "$dst" -j DROP
done
iptables -C INPUT -i "$NET" -j DROP 2>/dev/null || iptables -I INPUT -i "$NET" -j DROP
echo "sandbox network $NET ($SUBNET) ready"
