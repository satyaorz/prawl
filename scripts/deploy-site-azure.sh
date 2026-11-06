#!/usr/bin/env bash
# Serve the wallet website (apps/wallet/dist-web) over https from the same VM as the gateway.
# Caddy fetches and renews the certificate by itself (needs TCP 80 and 443 open to the internet).
#
#   pnpm --filter ./apps/wallet build:web        # with VITE_PRAWL_GATEWAY set, see gateway/deploy-remote.sh
#   scripts/deploy-site-azure.sh azureuser@<ip> <fqdn>
#
# The same headers as apps/wallet/vercel.json are sent. Rerunning uploads the new build in place.
# The passkey is bound to <fqdn>: pick the name once; a different name is a different wallet.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOST=${1:?usage: scripts/deploy-site-azure.sh user@host fqdn}
FQDN=${2:?usage: scripts/deploy-site-azure.sh user@host fqdn}
DIST=${PRAWL_SITE_DIST:-$ROOT/apps/wallet/dist-web}
[[ $FQDN =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "bad host name: $FQDN"; exit 1; }
[ -f "$DIST/index.html" ] || { echo "no build at $DIST (run: pnpm --filter ./apps/wallet build:web)"; exit 1; }
[ -f "$DIST/.well-known/assetlinks.json" ] || { echo "$DIST has no .well-known/assetlinks.json (apps/wallet/public/.well-known/)"; exit 1; }
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST")

echo "== caddy"
"${SSH[@]}" 'command -v caddy >/dev/null || (sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null)
sudo install -d -o root -g root -m 0755 /var/www/prawl'

echo "== upload $(du -sh "$DIST" | cut -f1)"
tar -C "$DIST" -cf - . | "${SSH[@]}" 'sudo rm -rf /var/www/prawl/* && sudo tar -xf - -C /var/www/prawl --no-same-owner && sudo chown -R root:root /var/www/prawl && sudo chmod -R a+rX /var/www/prawl'

echo "== Caddyfile for $FQDN"
"${SSH[@]}" "sudo tee /etc/caddy/Caddyfile >/dev/null" <<CADDY
$FQDN {
	root * /var/www/prawl

	header {
		Referrer-Policy no-referrer
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Permissions-Policy "camera=(self), microphone=(), geolocation=(), interest-cohort=()"
	}

	@compressible not path /tor/*
	encode @compressible gzip

	@anonrpc path /anon-rpc/*
	header @anonrpc Content-Type "text/javascript; charset=utf-8"
	header @anonrpc Cache-Control "public, max-age=31536000, immutable"

	@tor path /tor/*
	header @tor Content-Type "application/zstd"
	header @tor Cache-Control "no-cache"

	@railgun path /railgun/*
	header @railgun Cache-Control "no-cache"
	@wasm path /railgun/*.wasm
	header @wasm Content-Type "application/wasm"
	@json path /railgun/*.json
	header @json Content-Type "application/json"

	@assetlinks path /.well-known/assetlinks.json
	header @assetlinks Content-Type "application/json"

	# The page itself always revalidates (assets are content-hashed and immutable): no stale page after a deploy.
	@html path / /index.html
	header @html Cache-Control "no-cache"

	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"

	file_server
}
CADDY
"${SSH[@]}" 'sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && sudo systemctl enable --now caddy >/dev/null 2>&1 && sudo systemctl reload caddy || { sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -5; exit 1; }'

echo "== waiting for the certificate"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$FQDN/"; then echo "ready: https://$FQDN/"; exit 0; fi
  sleep 3
done
echo "https://$FQDN/ did not answer yet; see: ssh $HOST journalctl -u caddy -n 30"; exit 1
