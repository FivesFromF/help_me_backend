output "api_endpoint" {
  description = "The endpoint for the API Gateway"
  value       = module.apigateway.api_endpoint
}

output "write_service_endpoint" {
  description = "The endpoint for the Write service"
  value       = module.ecs.write_service_endpoint
}

output "read_service_endpoint" {
  description = "The endpoint for the Read service"
  value       = module.ecs.read_service_endpoint
}

output "audit_logs_table" {
  description = "The DynamoDB table for audit logs"
  value       = module.dynamodb.audit_table_name
}
