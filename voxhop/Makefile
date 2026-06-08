.PHONY: bootstrap build-ami deploy issue-cert destroy start stop logs status build test deploy-app

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

# ─── ECR App-Layer Deploy (Phase 2) ──────────────────────────────────────────
# Replaces AMI rebuild for app code changes. Runs in <5 minutes on warm cache.
# Prerequisites: AWS CLI configured, docker running, terraform apply done.
# Instance access via SSM (port 22 not open — SG allows 443+3000 only).
# Set ECR_REGION if not eu-north-1. Run from voxhop/ directory.
ECR_REGION  ?= eu-north-1
ECR_ACCOUNT  = $(shell aws sts get-caller-identity --query Account --output text)
ECR_PREFIX   = $(ECR_ACCOUNT).dkr.ecr.$(ECR_REGION).amazonaws.com
INSTANCE_ID  = $(shell terraform -chdir=infra output -raw instance_id)

deploy-app:
	@echo "[voxhop] Building React client (must run before Docker build picks up static/)..."
	cd ../voxhop-simulator/client && npm ci --prefer-offline && npm run build
	@echo "[voxhop] Logging in to ECR..."
	aws ecr get-login-password --region $(ECR_REGION) | \
	  docker login --username AWS --password-stdin $(ECR_PREFIX)
	@echo "[voxhop] Building app images in parallel..."
	docker build -t $(ECR_PREFIX)/voxhop-app:latest -f Dockerfile . & \
	docker build -t $(ECR_PREFIX)/voxhop-simulator:latest -f ../voxhop-simulator/Dockerfile ../voxhop-simulator/ & \
	docker build -t $(ECR_PREFIX)/voxhop-counterparty:latest -f ../voxhop-counterparty/Dockerfile ../voxhop-counterparty/ & \
	docker build -t $(ECR_PREFIX)/voxhop-piper:latest -f piper-http/Dockerfile piper-http/ & \
	wait
	@echo "[voxhop] Pushing images to ECR..."
	docker push $(ECR_PREFIX)/voxhop-app:latest
	docker push $(ECR_PREFIX)/voxhop-simulator:latest
	docker push $(ECR_PREFIX)/voxhop-counterparty:latest
	docker push $(ECR_PREFIX)/voxhop-piper:latest
	@echo "[voxhop] Uploading docker-compose.yml to S3 for instance download..."
	aws s3 cp docker-compose.yml s3://voxhop-debug-$(ECR_ACCOUNT)/deploy/docker-compose.yml
	@echo "[voxhop] Triggering SSM pull + restart on instance..."
	aws ssm send-command \
	  --region $(ECR_REGION) \
	  --instance-ids $(INSTANCE_ID) \
	  --document-name "AWS-RunShellScript" \
	  --parameters "commands=[ \
	    \"set -e\", \
	    \"aws s3 cp s3://voxhop-debug-$(ECR_ACCOUNT)/deploy/docker-compose.yml /opt/voxhop/docker-compose.yml\", \
	    \"aws ecr get-login-password --region $(ECR_REGION) | docker login --username AWS --password-stdin $(ECR_PREFIX)\", \
	    \"cd /opt/voxhop\", \
	    \"ECR_APP_URL=$(ECR_PREFIX)/voxhop-app:latest ECR_SIMULATOR_URL=$(ECR_PREFIX)/voxhop-simulator:latest ECR_COUNTERPARTY_URL=$(ECR_PREFIX)/voxhop-counterparty:latest ECR_PIPER_URL=$(ECR_PREFIX)/voxhop-piper:latest docker compose pull voxhop voxhop-simulator voxhop-counterparty piper-http\", \
	    \"ECR_APP_URL=$(ECR_PREFIX)/voxhop-app:latest ECR_SIMULATOR_URL=$(ECR_PREFIX)/voxhop-simulator:latest ECR_COUNTERPARTY_URL=$(ECR_PREFIX)/voxhop-counterparty:latest ECR_PIPER_URL=$(ECR_PREFIX)/voxhop-piper:latest docker compose up -d voxhop voxhop-simulator voxhop-counterparty piper-http\" \
	  ]" \
	  --output text --query "Command.CommandId"
	@echo "[voxhop] deploy-app dispatched — check SSM console or run: aws ssm list-command-invocations --region $(ECR_REGION) --instance-id $(INSTANCE_ID) --details"
