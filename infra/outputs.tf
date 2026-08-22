output "alb_dns_name" {
  description = "The public DNS name for the Application Load Balancer"
  value       = module.alb.alb_dns_name
}

output "cognito_user_pool_id" {
  description = "The ID of the Cognito User Pool"
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "The ID of the Cognito Client"
  value       = module.auth.client_id
}

output "audit_logs_table" {
  description = "The DynamoDB table for audit logs"
  value       = module.dynamodb.audit_table_name
}

output "system_bus_name" {
  description = "The name of the Core System EventBridge bus"
  value       = module.eventbridge.system_bus_name
}

output "emergency_bus_name" {
  description = "The name of the Emergency EventBridge bus"
  value       = module.eventbridge.emergency_bus_name
}

output "rds_cluster_endpoint" {
  description = "The endpoint of the RDS cluster"
  value       = module.rds.cluster_endpoint
}

output "api_url" {
  description = "HTTPS entry point for the API (CloudFront in front of the ALB)"
  value       = module.cloudfront.api_url
}
