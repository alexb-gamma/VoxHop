terraform {
  backend "s3" {
    bucket         = "voxhop-terraform-state"
    key            = "voxhop/terraform.tfstate"
    region         = "eu-north-1"
    dynamodb_table = "voxhop-terraform-locks"
    encrypt        = true
  }
}
