terraform {
  required_version = ">= 1.0.0"

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
      Environment = var.environment
      Project     = "HelpMe"
      ManagedBy   = "Terraform"
    }
  }
}

module "networking" {
  source = "./modules/networking"

  environment = var.environment
  vpc_cidr    = var.vpc_cidr
}

module "security" {
  source = "./modules/security"

  environment = var.environment
}

module "database" {
  source = "./modules/database"

  environment      = var.environment
  vpc_id           = module.networking.vpc_id
  private_subnets  = module.networking.private_subnets
  db_name          = "helpmedb"
  master_username  = "adminuser"
}

module "compute" {
  source = "./modules/compute"

  environment     = var.environment
  vpc_id          = module.networking.vpc_id
  public_subnets  = module.networking.public_subnets
  private_subnets = module.networking.private_subnets
  alb_sg_id       = module.networking.alb_sg_id
}
