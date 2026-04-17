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

module "timestream" {
  source = "./modules/timestream"

  project_name = var.project_name
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

  project_name     = var.project_name
  timestream_db    = module.timestream.database_name
  timestream_table = module.timestream.table_name
  event_bus_arn    = module.eventbridge.bus_arn
  sns_topic_arn    = module.sns.topic_arn
  database_url     = "postgres://adminuser:${var.db_password}@${module.rds.cluster_endpoint}:5432/helpme"
  session_table_arn  = module.dynamodb.table_arn
  session_table_name = module.dynamodb.table_name
}

module "auth" {
  source = "./modules/auth"

  project_name = var.project_name
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

  project_name       = var.project_name
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.public_subnets
  read_container_image  = var.read_container_image
  write_container_image = var.write_container_image
  timestream_db      = module.timestream.database_name
  timestream_table   = module.timestream.table_name
  event_bus_name     = module.eventbridge.bus_name
  event_bus_arn      = module.eventbridge.bus_arn
  session_table_name = module.dynamodb.table_name
  session_table_arn  = module.dynamodb.table_arn
  db_cluster_endpoint = module.rds.cluster_endpoint
  db_password        = var.db_password
  system_secret      = var.system_secret
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
  write_service_dns = module.ecs.write_service_dns
  read_service_dns  = module.ecs.read_service_dns
  authorizer_uri    = module.authorizer.authorizer_uri
}
