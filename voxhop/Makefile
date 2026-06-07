.PHONY: bootstrap build-ami deploy issue-cert destroy start stop logs status build test

# ─── Bootstrap (one-time) ─────────────────────────────────────────────────────
bootstrap:
	@echo "[voxhop] Bootstrapping Terraform state backend..."
	cd infra && terraform init && terraform apply -target=aws_s3_bucket.terraform_state -target=aws_dynamodb_table.terraform_locks -auto-approve
	@echo "[voxhop] Bootstrap complete."

# ─── AMI Build ────────────────────────────────────────────────────────────────
build-ami:
	@echo "[voxhop] Creating source tarball for Packer (excludes node_modules, dist, infra)..."
	tar -czf /tmp/voxhop-src.tar.gz \
		--exclude=./node_modules \
		--exclude=./dist \
		--exclude=./infra \
		-C . .
	@echo "[voxhop] Tarball ready at /tmp/voxhop-src.tar.gz"
	@echo "[voxhop] Building VoxHop Packer AMI in eu-north-1..."
	cd infra/packer && packer build voxhop-ami.pkr.hcl
	@echo "[voxhop] AMI build complete. Update ami_id in infra/variables.tf."

# ─── Deploy (P1-04) ───────────────────────────────────────────────────────────
# M-08: NS delegation banner BEFORE terraform apply.
# MN-07: make deploy MUST NOT invoke certbot or issue-cert.sh.
deploy:
	@echo "================================================"
	@echo "VoxHop Deploy — NS Delegation Required"
	@echo "================================================"
	@echo ""
	@echo "IMPORTANT: After terraform apply completes, you MUST:"
	@echo "  1. Run: terraform -chdir=infra output -json ns_records"
	@echo "  2. Add the 4 NS records printed above to borshik.net registrar"
	@echo "  3. Confirm propagation:"
	@echo "       dig NS voxhop.borshik.net @8.8.8.8 | grep awsdns"
	@echo "  4. Then run the TLS certificate issuance step (separate make target)"
	@echo ""
	@echo "DO NOT run the certificate issuance step before NS delegation is confirmed."
	@echo "================================================"
	@echo ""
	terraform -chdir=infra init
	terraform -chdir=infra apply -auto-approve
	@echo ""
	@echo "[voxhop] Terraform apply complete. NS records for voxhop.borshik.net:"
	@terraform -chdir=infra output -json ns_records 2>/dev/null || true
	@echo ""
	@echo "================================================"
	@echo "Next step: Add the NS records above to borshik.net registrar."
	@echo "Confirm: dig NS voxhop.borshik.net @8.8.8.8 | grep awsdns"
	@echo "Then run the TLS certificate issuance step (separate make target)."
	@echo "================================================"
	@echo ""
	docker compose up -d
	@echo "[voxhop] Deploy complete. All 7 services starting..."

# ─── Issue TLS Certificate (P1-04, M-07) ─────────────────────────────────────
# MUST be run MANUALLY after NS delegation is confirmed.
# MN-07: This target is intentionally SEPARATE from make deploy.
issue-cert:
	@echo "[voxhop] Running issue-cert.sh (requires NS delegation confirmed)..."
	/usr/local/bin/issue-cert.sh

# ─── Destroy (P1-04) ──────────────────────────────────────────────────────────
destroy:
	@echo "[voxhop] Stopping Docker Compose stack..."
	docker compose down || true
	@echo "[voxhop] Destroying VoxHop AWS resources..."
	terraform -chdir=infra destroy -auto-approve
	@echo "[voxhop] Terraform destroy complete. Running post-destroy tag scan..."
	@$(MAKE) _tag-scan-gate

_tag-scan-gate:
	@echo "[voxhop] Scanning for residual Project=voxhop tagged resources..."
	@RESULT=$$(aws resourcegroupstaggingapi get-resources \
		--tag-filters Key=Project,Values=voxhop \
		--query 'ResourceTagMappingList[*].ResourceARN' \
		--output text); \
	if [ -n "$$RESULT" ]; then \
		echo "[voxhop] ERROR: Residual tagged resources found — destroy FAILED:"; \
		echo "$$RESULT"; \
		exit 1; \
	else \
		echo "[voxhop] CLEAN DESTROY — zero voxhop-tagged resources remain."; \
	fi

# ─── Operational Commands ─────────────────────────────────────────────────────
start:
	@echo "[voxhop] Starting VoxHop Docker Compose stack..."
	docker compose up -d
	@echo "[voxhop] Polling /health until Whisper VRAM loaded..."
	@timeout 120 bash -c 'until curl -sf http://localhost:3000/health; do echo "Waiting..."; sleep 5; done'
	@echo "[voxhop] VoxHop is ready."

stop:
	@echo "[voxhop] Stopping VoxHop Docker Compose stack..."
	docker compose down

logs:
	docker compose logs -f

status:
	@echo "[voxhop] Service status:"
	docker compose ps
	@echo ""
	@echo "[voxhop] Health check:"
	@curl -sf http://localhost:3000/health && echo "OK" || echo "NOT READY"

# ─── Local Dev ────────────────────────────────────────────────────────────────
build:
	npm run build

test:
	npm test
