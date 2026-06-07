#!/bin/bash
# issue-cert.sh — VoxHop TLS certificate issuance via Certbot DNS-01
#
# USAGE:
#   make issue-cert     (invokes this script)
#
# PREREQUISITES:
#   1. NS delegation complete: borshik.net delegated to Route 53 NS records
#   2. EC2 IAM role has Route 53 permissions (provisioned by P1-01 Terraform)
#   3. Terraform has been applied (Route 53 zone exists)
#
# M-07: NS preflight check before any certbot call.
# M-07: First attempt uses --staging (validates DNS-01 flow, no rate limits).
# MN-01: Uses --dns-route53 ONLY (DNS-01 challenge; no HTTP-01 authenticators).
# MN-07: MUST NOT be invoked by make deploy (manual step after NS propagation).

set -e

EMAIL="admin@borshik.net"
DOMAIN="simulator.voxhop.borshik.net"

echo "================================================"
echo "VoxHop TLS Certificate Issuance"
echo "================================================"
echo ""

# ─── Preflight: NS delegation check (M-07, AR-01) ───────────────────────────
echo "[issue-cert] PREFLIGHT: Checking NS delegation for voxhop.borshik.net via @8.8.8.8..."

if ! dig NS voxhop.borshik.net @8.8.8.8 | grep -q "awsdns"; then
  echo ""
  echo "[issue-cert] ERROR: NS delegation not confirmed."
  echo "[issue-cert] The voxhop.borshik.net zone is NOT yet delegated to AWS Route 53."
  echo ""
  echo "[issue-cert] Required steps:"
  echo "[issue-cert]   1. Run: terraform -chdir=infra output -json ns_records"
  echo "[issue-cert]   2. Add those 4 NS records to the borshik.net registrar"
  echo "[issue-cert]   3. Confirm propagation: dig NS voxhop.borshik.net @8.8.8.8 | grep awsdns"
  echo "[issue-cert]   4. Optionally confirm via 1.1.1.1: dig NS voxhop.borshik.net @1.1.1.1 | grep awsdns"
  echo "[issue-cert]   5. Then re-run: make issue-cert"
  echo ""
  echo "[issue-cert] Exiting. Zero certbot calls made. Zero rate-limit attempts consumed."
  exit 1
fi

echo "[issue-cert] NS delegation CONFIRMED — awsdns nameservers resolved."
echo ""

# ─── Step 1: Staging cert (validates DNS-01 flow, no rate limits) ───────────
# AR-01 guard: staging first to verify DNS-01 plumbing before live issuance.
echo "[issue-cert] Step 1: Staging cert issuance (validates DNS-01 flow — not browser-trusted)..."
certbot certonly \
  --dns-route53 \
  --staging \
  --non-interactive \
  --agree-tos \
  --email "${EMAIL}" \
  -d "${DOMAIN}"

echo ""
echo "[issue-cert] Staging cert issued successfully. DNS-01 flow confirmed."
echo ""

# ─── Step 2: Live cert issuance ──────────────────────────────────────────────
echo "[issue-cert] Step 2: Live cert issuance (browser-trusted, Let's Encrypt ACME)..."
certbot certonly \
  --dns-route53 \
  --non-interactive --agree-tos \
  --email "${EMAIL}" \
  --force-renewal \
  -d "${DOMAIN}"

echo ""
echo "[issue-cert] ================================================"
echo "[issue-cert] Live TLS cert issued successfully."
echo "[issue-cert] Cert path: /etc/letsencrypt/live/${DOMAIN}/"
echo "[issue-cert]   fullchain.pem — certificate chain"
echo "[issue-cert]   privkey.pem   — private key"
echo ""
echo "[issue-cert] Next: restart voxhop-simulator to load the new cert:"
echo "[issue-cert]   docker compose restart voxhop-simulator"
echo "[issue-cert] ================================================"
