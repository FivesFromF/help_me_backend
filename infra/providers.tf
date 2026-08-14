terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.23.0"
    }
  }

  backend "s3" {
    bucket         = "helpme-terraform-state-xyz"
    key            = "state/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "helpme-terraform-locks-xyz"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "HelpMe"
      ManagedBy = "Terraform"
    }
  }
}
