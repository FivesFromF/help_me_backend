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

module "eventbridge" {
  source                         = "./modules/eventbridge"
  project_name                   = var.project_name
  audit_lambda_arn               = module.lambda.audit_lambda_arn
  notification_lambda_arn        = module.lambda.notification_lambda_arn # Fixed reference
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

  # Database URL (Supabase)
  database_url = var.supabase_db_url
  
  # AI Service & Secrets
  ai_service_url     = "http://${module.ai_service.repository_url}:8000" # Placeholder
  ai_internal_secret = var.ai_internal_secret
  system_secret      = var.system_secret

  # Cognito Reference
  user_pool_arn = module.auth.user_pool_arn
  user_pool_id  = module.auth.user_pool_id
  client_id     = module.auth.client_id

  # DynamoDB References
  sessions_table_name = module.dynamodb.sessions_table_name
  sessions_table_arn  = module.dynamodb.sessions_table_arn
  audit_table_name    = module.dynamodb.audit_table_name
  audit_table_arn     = module.dynamodb.audit_table_arn

  # S3 Reference
  avatars_bucket_name = module.s3.bucket_name
  avatars_bucket_arn  = module.s3.bucket_arn

  # EventBridge Rule ARNs
  audit_system_rule_arn    = module.eventbridge.audit_system_rule_arn
  audit_emergency_rule_arn = module.eventbridge.audit_emergency_rule_arn
  identification_rule_arn  = module.eventbridge.identification_rule_arn
  
  # Bus Info
  system_bus_name    = module.eventbridge.system_bus_name
  system_bus_arn     = module.eventbridge.system_bus_arn
  emergency_bus_name = module.eventbridge.emergency_bus_name
  emergency_bus_arn  = module.eventbridge.emergency_bus_arn
}

module "auth" {
  source        = "./modules/auth"
  project_name  = var.project_name
  random_suffix = var.random_suffix != "" ? var.random_suffix : random_string.suffix.result
  
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

  post_confirmation_lambda_arn = module.lambda.post_confirmation_lambda_arn
}

module "s3" {
  source        = "./modules/s3"
  project_name  = var.project_name
  random_suffix = var.random_suffix != "" ? var.random_suffix : random_string.suffix.result
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
  ai_internal_secret             = var.ai_internal_secret
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
  subnet_ids            = module.vpc.public_subnets
  
  # Bus Info
  system_bus_name       = module.eventbridge.system_bus_name
  system_bus_arn        = module.eventbridge.system_bus_arn
  emergency_bus_name    = module.eventbridge.emergency_bus_name
  emergency_bus_arn     = module.eventbridge.emergency_bus_arn

  # Images (Deprecated but required by module variables for now)
  read_container_image  = "DEPRECATED"
  write_container_image = "DEPRECATED"

  # DB & Secret
  db_cluster_endpoint   = "DEPRECATED"
  db_password           = "DEPRECATED"
  system_secret         = var.system_secret

  # DynamoDB Sessions
  sessions_table_name   = module.dynamodb.sessions_table_name
  sessions_table_arn    = module.dynamodb.sessions_table_arn

  # Cognito & Audit
  user_pool_id     = module.auth.user_pool_id
  client_id        = module.auth.client_id
  audit_table_name = module.dynamodb.audit_table_name

  # S3 Avatars
  avatars_bucket_name = module.s3.bucket_name
  avatars_bucket_arn  = module.s3.bucket_arn

  # Budget Architecture additions
  service_discovery_namespace_id = module.vpc.service_discovery_namespace_id
  lambda_proxy_sg_id             = "DEPRECATED" # Placeholder
}

module "apigateway" {
  source                 = "./modules/apigateway"
  project_name           = var.project_name
  read_lambda_arn        = module.lambda.read_service_arn
  write_lambda_arn       = module.lambda.write_service_arn
  authorizer_uri         = module.authorizer.authorizer_uri
}

variable "random_suffix" {
  description = "Unique suffix for resources"
  type        = string
  default     = ""
}




