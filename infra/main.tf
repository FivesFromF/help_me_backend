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
  source                      = "./modules/eventbridge"
  project_name            = var.project_name
  audit_lambda_arn        = module.lambda.audit_lambda_arn
  notification_lambda_arn = module.lambda.notification_lambda_arn
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
  audit_table_name    = module.dynamodb.audit_table_name
  audit_table_arn     = module.dynamodb.audit_table_arn

  # EventBridge Rule ARNs
  audit_system_rule_arn    = module.eventbridge.audit_system_rule_arn
  audit_emergency_rule_arn = module.eventbridge.audit_emergency_rule_arn
  identification_rule_arn  = module.eventbridge.identification_rule_arn

  # EventBridge Bus Name (for post-authentication sign-in event)
  core_system_bus_name = module.eventbridge.system_bus_name
}

module "auth" {
  source        = "./modules/auth"
  project_name  = var.project_name
  random_suffix = var.random_suffix != "" ? var.random_suffix : random_string.suffix.result

  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

  post_confirmation_lambda_arn  = module.lambda.post_confirmation_lambda_arn
}

module "s3" {
  source        = "./modules/s3"
  project_name  = var.project_name
  random_suffix = var.random_suffix != "" ? var.random_suffix : random_string.suffix.result
}

module "sqs" {
  source              = "./modules/sqs"
  project_name        = var.project_name
  avatars_bucket_name = module.s3.bucket_name
}

# The AI worker writes face embeddings and access sessions straight to Postgres, so its task SG needs
# the same 5432 path the Express tasks already have. Without it the container reaches SQS, S3 and
# DynamoDB (public endpoints) but every DB call ends in `Connection timed out` — packets dropped, not
# refused — and every job dies at "Database connection unavailable" after passing the whole AI
# pipeline. Kept as a standalone rule so modules/rds does not have to depend on modules/ai_service,
# which already depends on it for the endpoint.
resource "aws_security_group_rule" "ai_tasks_to_rds" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = module.rds.security_group_id
  source_security_group_id = module.ai_service.security_group_id
  description              = "helpme-ai tasks to RDS 5432"
}

module "ai_service" {
  source                         = "./modules/ai_service"
  project_name                   = var.project_name
  vpc_id                         = module.vpc.vpc_id
  public_subnet_ids              = module.vpc.public_subnets
  execution_role_arn             = module.ecs.execution_role_arn
  cluster_id                     = module.ecs.cluster_id

  # Queue & Storage Integration
  queue_url            = module.sqs.queue_url
  queue_arn            = module.sqs.queue_arn
  scan_jobs_table_name = module.dynamodb.scan_jobs_table_name
  scan_jobs_table_arn  = module.dynamodb.scan_jobs_table_arn
  avatars_bucket_name  = module.s3.bucket_name
  avatars_bucket_arn   = module.s3.bucket_arn
  db_cluster_endpoint  = module.rds.cluster_endpoint
  db_password          = var.db_password
  emergency_bus_name   = module.eventbridge.emergency_bus_name
  emergency_bus_arn    = module.eventbridge.emergency_bus_arn
}

module "alb" {
  source            = "./modules/alb"
  project_name      = var.project_name
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnets
}

module "ecs" {
  source       = "./modules/ecs"
  project_name = var.project_name
  vpc_id       = module.vpc.vpc_id
  subnet_ids   = module.vpc.public_subnets # Using public subnets for MVP simplicity (assign_public_ip=true)

  # modules/ecs registers write/read in Cloud Map (aws_service_discovery_service), which needs the
  # namespace the VPC module already creates (helpme.local). The wiring was missing, so `plan`
  # failed with "The argument service_discovery_namespace_id is required".
  service_discovery_namespace_id = module.vpc.service_discovery_namespace_id

  # ALB Integration
  alb_sg_id              = module.alb.alb_sg_id
  write_target_group_arn = module.alb.write_target_group_arn
  read_target_group_arn  = module.alb.read_target_group_arn

  # Bus Info
  system_bus_name    = module.eventbridge.system_bus_name
  system_bus_arn     = module.eventbridge.system_bus_arn
  emergency_bus_name = module.eventbridge.emergency_bus_name
  emergency_bus_arn  = module.eventbridge.emergency_bus_arn

  # Images
  read_container_image  = var.read_container_image
  write_container_image = var.write_container_image

  # DB & Secret
  db_cluster_endpoint = module.rds.cluster_endpoint
  db_password         = var.db_password
  system_secret       = var.system_secret

  # DynamoDB Sessions

  # Cognito & Audit
  user_pool_id     = module.auth.user_pool_id
  client_id        = module.auth.client_id
  audit_table_name = module.dynamodb.audit_table_name

  # S3 Avatars
  avatars_bucket_name = module.s3.bucket_name
  avatars_bucket_arn  = module.s3.bucket_arn
}

variable "random_suffix" {
  description = "Unique suffix for resources"
  type        = string
  default     = ""
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

# TLS front door. See modules/cloudfront/main.tf for why the ALB cannot terminate TLS itself.
module "cloudfront" {
  source       = "./modules/cloudfront"
  project_name = var.project_name
  alb_dns_name = module.alb.alb_dns_name
}
