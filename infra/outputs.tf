output "api_endpoint" {
  description = "The endpoint for the API Gateway"
  value       = module.apigateway.api_endpoint
}

output "alb_dns_name" {
  description = "The DNS name of the ALB"
  value       = module.ecs.alb_dns_name
}
