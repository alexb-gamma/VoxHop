variable "aws_region" {
  description = "AWS region for VoxHop deployment"
  type        = string
  default     = "eu-north-1"
}

variable "instance_type" {
  description = "EC2 instance type. g5.xlarge (A10G) for production, g4dn.xlarge as fallback."
  type        = string
  default     = "g5.xlarge"

  validation {
    condition     = contains(["g5.xlarge", "g4dn.xlarge", "t3.medium"], var.instance_type)
    error_message = "instance_type must be g5.xlarge (A10G), g4dn.xlarge (T4 fallback), or t3.medium (CPU test)."
  }
}

variable "ami_id" {
  description = "Packer-built VoxHop AMI ID. Run 'make build-ami' to generate."
  type        = string
  default     = "ami-0cae9aa0e65457fa4"
}

variable "gamma_bridge_cidr" {
  description = "CIDR block for telco-ai-bridge private IP (inbound WebSocket access)"
  type        = string
  default     = "10.0.0.0/8"
}

# eu-west-1 fallback variables (for CPU testing while A10G quota pending — ID-03)
variable "fallback_region" {
  description = "Fallback AWS region (eu-west-1) for CPU-mode testing while eu-north-1 A10G quota pending"
  type        = string
  default     = "eu-west-1"
}

variable "fallback_instance_type" {
  description = "CPU instance type for fallback region testing"
  type        = string
  default     = "t3.medium"
}
