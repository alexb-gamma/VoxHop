/**
 * VoxHop — Terraform Infrastructure
 *
 * Provisions: VPC, subnet, IGW, SG, IAM, EC2 A10G, EIP, S3, DynamoDB.
 * All resources tagged Project=voxhop.
 * IAM includes tag:GetResources for make destroy tag-scan gate (ID-04, ACC-14).
 */

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "voxhop"
      Environment = "poc"
      ManagedBy   = "terraform"
    }
  }
}

# ─── State Backend Resources (bootstrapped by make bootstrap) ─────────────────

resource "aws_s3_bucket" "terraform_state" {
  bucket = "voxhop-terraform-state"

  force_destroy = true

  lifecycle {
    prevent_destroy = false
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = "voxhop-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# ─── VPC ──────────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "voxhop-vpc"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = {
    Name = "voxhop-public-subnet"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "voxhop-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "voxhop-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ─── Security Groups ──────────────────────────────────────────────────────────

resource "aws_security_group" "voxhop" {
  name        = "voxhop-sg"
  description = "VoxHop security group - allows telco-ai-bridge WebSocket inbound"
  vpc_id      = aws_vpc.main.id

  # WebSocket from telco-ai-bridge
  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.gamma_bridge_cidr]
    description = "VoxHop WebSocket from telco-ai-bridge"
  }

  # HTTPS for SSM Session Manager
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS inbound"
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All egress"
  }

  tags = {
    Name = "voxhop-sg"
  }
}

# ─── IAM ──────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "voxhop_ec2" {
  name = "voxhop-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "voxhop_ec2" {
  name = "voxhop-ec2-policy"
  role = aws_iam_role.voxhop_ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # S3 access for debug bucket and state
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.debug.arn,
          "${aws_s3_bucket.debug.arn}/*",
        ]
      },
      {
        # SSM Session Manager (no SSH required)
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
      {
        # tag:GetResources — required for make destroy tag-scan gate (ID-04, ACC-14)
        Effect   = "Allow"
        Action   = ["tag:GetResources"]
        Resource = "*"
      },
      {
        # Route 53 permissions for Certbot DNS-01 challenge (P1-01, M-07)
        Effect = "Allow"
        Action = [
          "route53:GetChange",
        ]
        Resource = "arn:aws:route53:::change/*"
      },
      {
        # Route 53 permissions for Certbot DNS-01 challenge (P1-01, M-07)
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
        ]
        Resource = [aws_route53_zone.voxhop.arn]
      },
      {
        # Route 53 list hosted zones (required by certbot-dns-route53 plugin)
        Effect   = "Allow"
        Action   = ["route53:ListHostedZones", "route53:ListHostedZonesByName"]
        Resource = "*"
      },
      {
        # ECR pull access (Phase 2 — app images pulled from ECR on deploy)
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = "*"
      }
    ]
  })
}

# ─── Route 53 (P1-01) ────────────────────────────────────────────────────────

# Hosted zone for voxhop.borshik.net sub-delegation
resource "aws_route53_zone" "voxhop" {
  name = "voxhop.borshik.net"

  tags = {
    Name = "voxhop-zone"
  }
}

# A record: simulator.voxhop.borshik.net → EIP (M-06: no hardcoded IP)
resource "aws_route53_record" "simulator_a" {
  zone_id = aws_route53_zone.voxhop.zone_id
  name    = "simulator"
  type    = "A"
  ttl     = 300
  records = [aws_eip.voxhop.public_ip]
}

resource "aws_iam_instance_profile" "voxhop" {
  name = "voxhop-instance-profile"
  role = aws_iam_role.voxhop_ec2.name
}

# ─── S3 Debug Bucket ──────────────────────────────────────────────────────────

resource "aws_s3_bucket" "debug" {
  bucket = "voxhop-debug-${data.aws_caller_identity.current.account_id}"

  force_destroy = true # ACC-14: prevent object-content blocking on destroy

  tags = {
    Name = "voxhop-debug"
  }
}

data "aws_caller_identity" "current" {}

# ─── EC2 A10G GPU Instance ───────────────────────────────────────────────────

resource "aws_instance" "voxhop" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.voxhop.id]
  iam_instance_profile   = aws_iam_instance_profile.voxhop.name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 200 # GB — model weights + Docker images
    delete_on_termination = true
    encrypted             = true
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -e
    cd /opt/voxhop
    docker compose up -d
    echo "VoxHop Docker Compose started at $(date)" >> /var/log/voxhop-startup.log
  EOF
  )

  tags = {
    Name = "voxhop-gpu"
  }
}

# ─── Elastic IP ───────────────────────────────────────────────────────────────

resource "aws_eip" "voxhop" {
  instance = aws_instance.voxhop.id
  domain   = "vpc"

  tags = {
    Name = "voxhop-eip"
  }
}

# ─── ECR Repositories (Phase 2) ───────────────────────────────────────────────

resource "aws_ecr_repository" "voxhop_app" {
  name                 = "voxhop-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-app-ecr" }
}

resource "aws_ecr_repository" "voxhop_simulator" {
  name                 = "voxhop-simulator"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-simulator-ecr" }
}

resource "aws_ecr_repository" "voxhop_counterparty" {
  name                 = "voxhop-counterparty"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-counterparty-ecr" }
}

resource "aws_ecr_repository" "voxhop_piper" {
  name                 = "voxhop-piper"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  tags = { Name = "voxhop-piper-ecr" }
}
