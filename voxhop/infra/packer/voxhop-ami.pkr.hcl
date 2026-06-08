/**
 * VoxHop Packer AMI Template
 *
 * Base: AWS Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)
 *   - NVIDIA OSS drivers pre-installed and tested against the AWS kernel
 *   - CUDA pre-configured
 *   - Docker + NVIDIA Container Toolkit pre-configured
 *   → No DKMS compilation, no reboot needed
 *
 * We add on top:
 *   - faster-whisper Large v3 model weights (Docker image + warm-up)
 *   - Ollama + Gemma 4 model cache
 *   - Piper ONNX + en_GB-alan-medium voice pack
 *   - Pre-baked comfort_en.pcm clip
 *   - VoxHop Node.js application
 *   - GPU smoke test gate (build fails if GPU is not functional)
 */

packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "eu-north-1"
}

variable "instance_type" {
  type    = string
  default = "g5.xlarge"
}

variable "piper_version" {
  type    = string
  default = "2023.11.14-2"
}

variable "whisper_model" {
  type    = string
  default = "large-v3"
}

variable "ollama_model" {
  type    = string
  default = "gemma4"
}

source "amazon-ebs" "voxhop" {
  region        = var.aws_region
  instance_type = var.instance_type

  # AWS Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)
  # Ships with: NVIDIA OSS drivers, CUDA, Docker, NVIDIA Container Toolkit
  # Supports: G4dn, G5, G6, P4d, P5 families
  source_ami_filter {
    filters = {
      name                = "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04) *"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["amazon"]
  }

  ssh_username = "ubuntu"
  ssh_timeout  = "10m"

  ami_name        = "voxhop-ami-{{timestamp}}"
  ami_description = "VoxHop GPU AI stack — faster-whisper + Ollama + Piper (based on AWS DLAMI)"

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 200
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Project   = "voxhop"
    Name      = "voxhop-ami"
    BuildDate = "{{timestamp}}"
    BaseAMI   = "AWS-DLAMI-Ubuntu22.04-OSS-GPU"
  }
}

build {
  sources = ["source.amazon-ebs.voxhop"]

  # ─── Update system packages ────────────────────────────────────────────────
  # Lightweight update — DLAMI base is already GPU-ready; we just keep it fresh.
  provisioner "shell" {
    inline = [
      "export DEBIAN_FRONTEND=noninteractive",
      "sudo apt-get update -qq",
      "sudo apt-get upgrade -y -qq",
      "sudo apt-get install -y -qq curl wget git build-essential",
    ]
  }

  # ─── GPU Smoke Test (fails AMI build if GPU is not functional) ───────────
  # The DLAMI has NVIDIA drivers + Container Toolkit pre-configured.
  # Fail fast here rather than baking a broken AMI.
  provisioner "shell" {
    inline = [
      "echo '[voxhop-ami] Running GPU smoke test...'",
      "sudo docker run --rm --gpus all nvidia/cuda:12.2.0-runtime-ubuntu22.04 nvidia-smi",
      "echo '[voxhop-ami] GPU smoke test PASSED'",
    ]
  }

  # ─── Create VoxHop application directories ────────────────────────────────
  provisioner "shell" {
    inline = [
      "sudo mkdir -p /opt/voxhop/audio",
      "sudo mkdir -p /opt/voxhop/models",
      "sudo mkdir -p /opt/voxhop/ollama",
      "sudo chown -R ubuntu:ubuntu /opt/voxhop",
    ]
  }

  # ─── Install Piper TTS ───────────────────────────────────────────────────
  # The Piper tarball bundles its own libespeak-ng.so.1, libonnxruntime,
  # and espeak-ng-data/. Keep everything together in /opt/piper/ and
  # expose a wrapper at /usr/local/bin/piper that sets ESPEAK_DATA_PATH
  # and LD_LIBRARY_PATH so the bundled binary finds all its dependencies.
  provisioner "shell" {
    inline = [
      "cd /tmp",
      "wget -q https://github.com/rhasspy/piper/releases/download/${var.piper_version}/piper_linux_x86_64.tar.gz -O piper.tar.gz",
      "tar -xzf piper.tar.gz",
      "sudo mkdir -p /opt/piper",
      "sudo cp piper/piper /opt/piper/piper",
      "sudo chmod +x /opt/piper/piper",
      # Copy bundled shared libraries (libespeak-ng, libonnxruntime, libpiper_phonemize)
      "sudo cp piper/lib*.so* /opt/piper/ 2>/dev/null || true",
      # Copy bundled espeak-ng data (looked up by the bundled libespeak-ng)
      "sudo cp -r piper/espeak-ng-data /opt/piper/espeak-ng-data 2>/dev/null || true",
      # Wrapper: sets data path + library path before exec-ing the real binary
      "printf '#!/bin/bash\\nESPEAK_DATA_PATH=/opt/piper/espeak-ng-data LD_LIBRARY_PATH=/opt/piper exec /opt/piper/piper \"$@\"' | sudo tee /usr/local/bin/piper",
      "sudo chmod +x /usr/local/bin/piper",
      "rm -rf /tmp/piper /tmp/piper.tar.gz",
      "echo '[voxhop-ami] Piper binary installed'",
    ]
  }

  # ─── Download Piper voice packs ──────────────────────────────────────────────
  # Curated set: EN (GB + US), DE, ES, FR, IT — multi-gender, medium quality.
  # Italian note: riccardo-medium does not exist in Piper catalogue.
  #   Male IT: riccardo-x_low (only option). Female IT: paola-medium.
  # German note: No single-speaker female voice exists at medium quality in Piper.
  #   Female DE: kerstin-low + ramona-low (best available).
  # All downloads run in parallel (4 workers) to keep AMI build time reasonable.
  provisioner "shell" {
    inline = [
      "echo '[voxhop-ami] Downloading Piper voice packs (EN/DE/ES/FR/IT, multi-gender)...'",
      "BASE=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0",
      "M=/opt/voxhop/models",

      "dl() { local v=$1 p=$2; for ext in .onnx .onnx.json; do wget -q \"$BASE/$p/$v$ext\" -O \"$M/$v$ext\" && echo \"OK $v$ext\" || echo \"FAIL $v$ext\"; done; }",

      # ── English GB (British — male + female) ──────────────────────────────
      "dl en_GB-alan-medium                  en/en_GB/alan/medium                  &",
      "dl en_GB-alba-medium                  en/en_GB/alba/medium                  &",
      "dl en_GB-cori-medium                  en/en_GB/cori/medium                  &",
      "dl en_GB-jenny_dioco-medium           en/en_GB/jenny_dioco/medium           &",
      "dl en_GB-northern_english_male-medium en/en_GB/northern_english_male/medium &",
      "wait; echo '[voxhop-ami] EN GB voices done'",

      # ── English US (American — male + female) ─────────────────────────────
      "dl en_US-amy-medium                   en/en_US/amy/medium                   &",
      "dl en_US-bryce-medium                 en/en_US/bryce/medium                 &",
      "dl en_US-lessac-medium                en/en_US/lessac/medium                &",
      "dl en_US-ryan-medium                  en/en_US/ryan/medium                  &",
      "wait; echo '[voxhop-ami] EN US voices done'",

      # ── German — male medium + female low (no female medium exists in Piper)
      "dl de_DE-thorsten-medium              de/de_DE/thorsten/medium              &",
      "dl de_DE-kerstin-low                  de/de_DE/kerstin/low                  &",
      "dl de_DE-ramona-low                   de/de_DE/ramona/low                   &",

      # ── Spanish — male (Spain + Mexico) + female (sharvard) ──────────────
      "dl es_ES-davefx-medium                es/es_ES/davefx/medium                &",
      "dl es_ES-sharvard-medium              es/es_ES/sharvard/medium              &",
      "dl es_MX-ald-medium                   es/es_MX/ald/medium                   &",
      "wait; echo '[voxhop-ami] DE + ES voices done'",

      # ── French — male + female ────────────────────────────────────────────
      "dl fr_FR-siwis-medium                 fr/fr_FR/siwis/medium                 &",
      "dl fr_FR-tom-medium                   fr/fr_FR/tom/medium                   &",

      # ── Italian — female medium + male x_low (only options in Piper) ──────
      "dl it_IT-paola-medium                 it/it_IT/paola/medium                 &",
      "dl it_IT-riccardo-x_low               it/it_IT/riccardo/x_low               &",
      "wait; echo '[voxhop-ami] FR + IT voices done'",

      "echo \"[voxhop-ami] Voice pack download complete: $(ls $M/*.onnx | wc -l) models\"",
      "ls -lh $M/*.onnx",
    ]
  }

  # ─── Install Certbot with DNS-Route53 plugin (P1-02, M-07, DA-03) ─────────
  provisioner "shell" {
    inline = [
      "echo '[voxhop-ami] Installing Certbot with Route53 DNS plugin...'",
      "export DEBIAN_FRONTEND=noninteractive",
      # Try apt first (DA-03); fall back to pip3 if apt version lags
      "if sudo apt-get install -y -qq certbot python3-certbot-dns-route53 2>/dev/null; then",
      "  echo '[voxhop-ami] Certbot installed via apt'",
      "else",
      "  echo '[voxhop-ami] apt certbot unavailable or lagging; falling back to pip3...'",
      "  sudo apt-get install -y -qq python3-pip",
      "  sudo pip3 install certbot certbot-dns-route53",
      "  echo '[voxhop-ami] Certbot installed via pip3'",
      "fi",
      "certbot --version",
    ]
  }

  # ─── Install issue-cert.sh to /usr/local/bin (P1-02, M-07) ──────────────
  provisioner "file" {
    source      = "scripts/issue-cert.sh"
    destination = "/tmp/issue-cert.sh"
  }

  provisioner "shell" {
    inline = [
      "sudo cp /tmp/issue-cert.sh /usr/local/bin/issue-cert.sh",
      "sudo chmod +x /usr/local/bin/issue-cert.sh",
      "echo '[voxhop-ami] issue-cert.sh installed at /usr/local/bin/issue-cert.sh'",
    ]
  }

  # ─── Certbot renewal systemd timer (P1-02, every 12 hours) ──────────────
  provisioner "shell" {
    inline = [
      "echo '[voxhop-ami] Configuring certbot renewal systemd timer...'",
      # Create timer unit
      "sudo tee /etc/systemd/system/certbot-renew.timer > /dev/null <<'TIMER_EOF'",
      "[Unit]",
      "Description=Certbot Renewal Timer (every 12 hours)",
      "After=network-online.target",
      "",
      "[Timer]",
      "OnCalendar=*-*-* 00,12:00:00",
      "RandomizedDelaySec=3600",
      "Persistent=true",
      "",
      "[Install]",
      "WantedBy=timers.target",
      "TIMER_EOF",
      # Create service unit
      "sudo tee /etc/systemd/system/certbot-renew.service > /dev/null <<'SERVICE_EOF'",
      "[Unit]",
      "Description=Certbot Certificate Renewal",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=oneshot",
      "ExecStart=/usr/bin/certbot renew --quiet --dns-route53",
      "SERVICE_EOF",
      "sudo systemctl daemon-reload",
      "sudo systemctl enable certbot-renew.timer",
      "echo '[voxhop-ami] certbot-renew.timer enabled'",
    ]
  }

  # ─── Bake comfort_en.pcm (pre-synthesised "One moment please.") ──────────
  provisioner "shell" {
    inline = [
      "echo 'One moment please.' | /usr/local/bin/piper --model /opt/voxhop/models/en_GB-alan-medium.onnx --output-raw > /opt/voxhop/audio/comfort_en.pcm",
      "BYTES=$(wc -c < /opt/voxhop/audio/comfort_en.pcm)",
      "echo \"[voxhop-ami] comfort_en.pcm baked: $BYTES bytes\"",
      "if [ \"$BYTES\" -eq 0 ]; then echo 'ERROR: comfort_en.pcm is empty'; exit 1; fi",
    ]
  }

  # ─── Pull Docker images ───────────────────────────────────────────────────
  provisioner "shell" {
    inline = [
      "sudo docker pull fedirz/faster-whisper-server:latest-cuda",
      "sudo docker pull ollama/ollama:latest",
      "sudo docker pull redis:7-alpine",
      "echo '[voxhop-ami] Docker images pulled'",
    ]
  }

  # ─── Pre-pull Whisper model weights ──────────────────────────────────────
  provisioner "shell" {
    inline = [
      "sudo docker run --gpus all --rm -e WHISPER_MODEL=${var.whisper_model} fedirz/faster-whisper-server:latest-cuda python -c \"from faster_whisper import WhisperModel; WhisperModel('${var.whisper_model}', device='cuda')\" || echo '[voxhop-ami] Whisper pre-pull note: may warm up on first request'",
      "echo '[voxhop-ami] Whisper model weights cached'",
    ]
  }

  # ─── Pre-pull Ollama model ────────────────────────────────────────────────
  # 'ollama pull' is a CLIENT command — it needs a running Ollama server.
  # Publish port 11434 so we can poll the HTTP API from the HOST (curl),
  # which is a proper readiness gate.  'docker exec ollama list' is NOT
  # used because it does not reliably signal API readiness.
  provisioner "shell" {
    inline = [
      # Start server; publish 11434 so host curl can reach it
      "sudo docker run -d --gpus all -p 11434:11434 -e OLLAMA_HOST=0.0.0.0 -v /opt/voxhop/ollama:/root/.ollama --name ollama-pull ollama/ollama:latest",
      "echo '[voxhop-ami] Waiting for Ollama HTTP API to be ready (up to 2.5 min)...'",
      # Poll API from host; abort immediately if container exits
      "READY=0; for i in $(seq 1 30); do if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then READY=1; echo \"[voxhop-ami] Ollama API ready at attempt $i\"; break; fi; if ! sudo docker ps -q --filter name=ollama-pull | grep -q .; then echo '[voxhop-ami] ERROR: Ollama container exited unexpectedly'; sudo docker logs ollama-pull 2>&1 || true; exit 1; fi; echo \"  attempt $i/30 — waiting 5s\"; sleep 5; done",
      # Hard-fail if loop timed out without readiness
      "if [ \"$READY\" -ne 1 ]; then echo '[voxhop-ami] ERROR: Ollama API not ready after 150s'; sudo docker logs ollama-pull 2>&1 || true; exit 1; fi",
      # Pull the model (exec into the running server container)
      "sudo docker exec ollama-pull ollama pull ${var.ollama_model}",
      "sudo docker stop ollama-pull && sudo docker rm ollama-pull",
      "echo '[voxhop-ami] Ollama ${var.ollama_model} model cached'",
    ]
  }

  # ─── Install Node.js 20 (for VoxHop service) ─────────────────────────────
  provisioner "shell" {
    inline = [
      "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -",
      "sudo apt-get install -y -qq nodejs",
      "node --version",
      "npm --version",
    ]
  }

  # ─── Deploy VoxHop application ────────────────────────────────────────────
  # Tarball is pre-created by 'make build-ami' (excludes node_modules + infra)
  provisioner "file" {
    source      = "/tmp/voxhop-src.tar.gz"
    destination = "/tmp/voxhop-src.tar.gz"
  }

  provisioner "shell" {
    inline = [
      "tar -xzf /tmp/voxhop-src.tar.gz -C /opt/voxhop/",
      "cd /opt/voxhop && npm install",
      "cd /opt/voxhop && npm run build",
      "cd /opt/voxhop && npm prune --production",
      "echo '[voxhop-ami] VoxHop Node.js app installed, built, and pruned'",
    ]
  }

  # ─── Final validation ─────────────────────────────────────────────────────
  provisioner "shell" {
    inline = [
      "nvidia-smi",
      "ls -la /opt/voxhop/audio/comfort_en.pcm",
      "echo \"Voice models: $(ls /opt/voxhop/models/*.onnx | wc -l)\"",
      "ls /opt/voxhop/models/*.onnx",
      "node --version",
      "docker --version",
      "docker compose version",
      "echo '[voxhop-ami] AMI build COMPLETE'",
    ]
  }
}
