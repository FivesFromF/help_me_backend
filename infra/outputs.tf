output "api_endpoint" {
  description = "The endpoint for the API Gateway"
  value       = module.apigateway.api_endpoint
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

output "access_sessions_table" {
  description = "The DynamoDB table for access sessions"
  value       = module.dynamodb.sessions_table_name
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
