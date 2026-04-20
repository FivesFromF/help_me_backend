resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

module "vpc" {
  source       = "./modules/vpc"
  project_name = var.project_name
  vpc_cidr     = "10.0.0.0/16"
}

module "dynamodb" {
  source       = "./modules/dynamodb"
  project_name = var.project_name
}

module "rds" {
  source          = "./modules/rds"
  project_name    = var.project_name
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets
  db_password     = var.db_password
  app_tasks_sg_id = module.ecs.app_tasks_sg_id
  bastion_sg_id   = module.bastion.bastion_sg_id
}

module "bastion" {
  source       = "./modules/bastion"
  project_name = var.project_name
  vpc_id       = module.vpc.vpc_id
  subnet_id    = module.vpc.public_subnets[0] # Use the first public subnet
}

module "eventbridge" {
  source                         = "./modules/eventbridge"
  project_name                   = var.project_name
  audit_lambda_arn               = module.lambda.audit_lambda_arn
  notification_lambda_arn        = module.lambda.notification_lambda_arn
  grant_permission_lambda_arn    = module.lambda.grant_permission_lambda_arn
}

module "lambda" {
  source       = "./modules/lambda"
  project_name = var.project_name

  # Credentials & Config
  smtp_host = var.smtp_host
  smtp_port = var.smtp_port
  smtp_user = var.smtp_user
  smtp_pass = var.smtp_pass
  smtp_from = var.smtp_from

  # Database URLs (Constructing for PostgreSQL)
  database_url = "postgres://adminuser:${var.db_password}@${module.rds.cluster_endpoint}:5432/helpme"
  
  # Cognito Reference
  user_pool_arn = module.auth.user_pool_arn

  # DynamoDB References
  sessions_table_name = module.dynamodb.sessions_table_name
  sessions_table_arn  = module.dynamodb.sessions_table_arn
  audit_table_name    = module.dynamodb.audit_table_name
  audit_table_arn     = module.dynamodb.audit_table_arn

  # EventBridge Rule ARNs
  audit_system_rule_arn    = module.eventbridge.audit_system_rule_arn
  audit_emergency_rule_arn = module.eventbridge.audit_emergency_rule_arn
  identification_rule_arn  = module.eventbridge.identification_rule_arn
}

module "auth" {
  source        = "./modules/auth"
  project_name  = var.project_name
  random_suffix = random_string.suffix.result
  
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

  post_confirmation_lambda_arn = module.lambda.post_confirmation_lambda_arn
}

module "authorizer" {
  source             = "./modules/authorizer"
  project_name       = var.project_name
  user_pool_id       = module.auth.user_pool_id
  client_id          = module.auth.client_id
  user_pool_endpoint = module.auth.user_pool_endpoint
  api_execution_arn  = module.apigateway.execution_arn
}

module "ecs" {
  source                = "./modules/ecs"
  project_name          = var.project_name
  vpc_id                = module.vpc.vpc_id
  subnet_ids            = module.vpc.public_subnets # Using public subnets for MVP simplicity (assign_public_ip=true)
  
  # Bus Info
  system_bus_name       = module.eventbridge.system_bus_name
  system_bus_arn        = module.eventbridge.system_bus_arn
  emergency_bus_name    = module.eventbridge.emergency_bus_name
  emergency_bus_arn     = module.eventbridge.emergency_bus_arn

  # Images
  read_container_image  = var.read_container_image
  write_container_image = var.write_container_image

  # DB & Secret
  db_cluster_endpoint   = module.rds.cluster_endpoint
  db_password           = var.db_password
  system_secret         = var.system_secret

  # DynamoDB Sessions
  sessions_table_name   = module.dynamodb.sessions_table_name
  sessions_table_arn    = module.dynamodb.sessions_table_arn

  # Cognito & Audit
  user_pool_id     = module.auth.user_pool_id
  client_id        = module.auth.client_id
  audit_table_name = module.dynamodb.audit_table_name
}

module "apigateway" {
  source                 = "./modules/apigateway"
  project_name           = var.project_name
  write_service_endpoint = module.ecs.write_service_endpoint
  read_service_endpoint  = module.ecs.read_service_endpoint
  authorizer_uri         = module.authorizer.authorizer_uri
}

module "ai_service" {
  source                         = "./modules/ai_service"
  project_name                   = var.project_name
  vpc_id                         = module.vpc.vpc_id
  public_subnet_ids              = module.vpc.public_subnets
  app_tasks_sg_id                = module.ecs.app_tasks_sg_id
  execution_role_arn             = module.ecs.execution_role_arn
  cluster_id                     = module.ecs.cluster_id
  service_discovery_namespace_id = module.vpc.service_discovery_namespace_id
}

output "bastion_instance_id" {
  value = module.bastion.instance_id
}

output "rds_endpoint" {
  value = module.rds.cluster_endpoint
}

output "ai_repository_url" {
  value = module.ai_service.repository_url
}
