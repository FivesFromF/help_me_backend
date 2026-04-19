terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

module "database" {
  source       = "./modules/database"
  project_name = var.project_name
}

module "bus" {
  source       = "./modules/bus"
  project_name = var.project_name
}

# Lambda must be created FIRST — auth module depends on post_confirmation ARN
module "lambda" {
  source       = "./modules/lambda"
  project_name = var.project_name

  user_pool_arn = module.auth.user_pool_arn

  smtp_host = var.smtp_host
  smtp_port = var.smtp_port
  smtp_user = var.smtp_user
  smtp_pass = var.smtp_pass
  smtp_from = var.smtp_from

  database_url        = module.database.db_url
  sessions_table_arn  = module.database.sessions_table_arn
  sessions_table_name = module.database.sessions_table_name
  audit_table_arn     = module.database.audit_table_arn
  audit_table_name    = module.database.audit_table_name

  audit_system_rule_arn    = module.bus.audit_system_rule_arn
  audit_emergency_rule_arn = module.bus.audit_emergency_rule_arn
  identification_rule_arn  = module.bus.identification_rule_arn
}

module "auth" {
  source        = "./modules/auth"
  project_name  = var.project_name
  random_suffix = random_string.suffix.result

  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

  # Wire in the Post Confirmation Lambda trigger
  post_confirmation_lambda_arn = module.lambda.post_confirmation_lambda_arn
}
