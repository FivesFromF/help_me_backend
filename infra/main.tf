terraform {
  backend "s3" {
    bucket         = "helpme-terraform-state-xyz"
    key            = "state/terraform.tfstate"
    region         = "ap-southeast-1"
    dynamodb_table = "helpme-terraform-locks-xyz"
    encrypt        = true
  }
}

module "vpc" {
  source = "./modules/vpc"

  project_name = var.project_name
  vpc_cidr     = var.vpc_cidr
}

module "dynamodb" {
  source = "./modules/dynamodb"

  project_name = var.project_name
}

module "sns" {
  source = "./modules/sns"

  project_name = var.project_name
}

module "eventbridge" {
  source = "./modules/eventbridge"

  project_name            = var.project_name
  audit_lambda_arn        = module.lambda.audit_lambda_arn
  notification_lambda_arn = module.lambda.notification_lambda_arn
  grant_permission_lambda_arn = module.lambda.grant_permission_lambda_arn
}

module "lambda" {
  source = "./modules/lambda"

  project_name       = var.project_name
  sns_topic_arn      = module.sns.topic_arn
  database_url       = "postgres://adminuser:${var.db_password}@${module.rds.cluster_endpoint}:5432/helpme"
  sessions_table_arn  = module.dynamodb.sessions_table_arn
  sessions_table_name = module.dynamodb.sessions_table_name
  audit_table_arn     = module.dynamodb.audit_table_arn
  audit_table_name    = module.dynamodb.audit_table_name

  # Dual-bus routing for workers
  audit_system_rule_arn    = module.eventbridge.audit_system_rule_arn
  audit_emergency_rule_arn   = module.eventbridge.audit_emergency_rule_arn
  identification_rule_arn  = module.eventbridge.identification_rule_arn
}

module "auth" {
  source = "./modules/auth"

  project_name            = var.project_name
  cognito_define_auth_arn = module.lambda.cognito_define_auth_arn
  cognito_create_auth_arn = module.lambda.cognito_create_auth_arn
  cognito_verify_auth_arn = module.lambda.cognito_verify_auth_arn
}

module "authorizer" {
  source = "./modules/authorizer"

  project_name       = var.project_name
  user_pool_id      = module.auth.user_pool_id
  client_id         = module.auth.client_id
  user_pool_endpoint = module.auth.user_pool_endpoint
  api_execution_arn  = module.apigateway.execution_arn
}

module "ecs" {
  source = "./modules/ecs"

  project_name          = var.project_name
  vpc_id                = module.vpc.vpc_id
  subnet_ids            = module.vpc.public_subnets
  read_container_image     = var.read_container_image
  write_container_image    = var.write_container_image
  
  # Inject both buses
  system_bus_name       = module.eventbridge.system_bus_name
  system_bus_arn        = module.eventbridge.system_bus_arn
  emergency_bus_name    = module.eventbridge.emergency_bus_name
  emergency_bus_arn     = module.eventbridge.emergency_bus_arn

  sessions_table_name   = module.dynamodb.sessions_table_name
  sessions_table_arn    = module.dynamodb.sessions_table_arn
  db_cluster_endpoint   = module.rds.cluster_endpoint
  db_password           = var.db_password
  system_secret         = var.system_secret
}

module "rds" {
  source = "./modules/rds"

  project_name       = var.project_name
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.public_subnets
  db_password        = var.db_password
  app_tasks_sg_id    = module.ecs.app_tasks_sg_id
}

module "apigateway" {
  source = "./modules/apigateway"

  project_name      = var.project_name
  # Temporarily hardcoding v3 endpoints due to provider state sync bug
  write_service_endpoint = "he-d2c8cccfcacf4038a239822368d8e326.ecs.ap-southeast-1.on.aws"
  read_service_endpoint  = "he-00cb9d1206904742851dceae1ad7e979.ecs.ap-southeast-1.on.aws"
  authorizer_uri    = module.authorizer.authorizer_uri
}

data "aws_caller_identity" "current" {}
