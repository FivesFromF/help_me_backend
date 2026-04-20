resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

# --- Authorizer ---

resource "aws_apigatewayv2_authorizer" "auth" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = var.authorizer_uri
  # Removing identity_sources to allow requests lacking Authentication headers to hit the Lambda Authorizer.
  name             = "${var.project_name}-authorizer"

  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  authorizer_result_ttl_in_seconds  = 0
}

# --- Integrations ---

resource "aws_apigatewayv2_integration" "write" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "HTTP_PROXY"
  integration_uri  = "http://${var.write_service_endpoint}:8081/{proxy}"
  integration_method = "ANY"
  
  request_parameters = {
    # This strips the /write-service/ prefix before sending to ALB
    "overwrite:path"             = "$request.path.proxy"
    "append:header.X-Cognito-Id" = "$context.authorizer.lambda.userId"
    "append:header.X-Role"       = "$context.authorizer.lambda.role"
  }
}

resource "aws_apigatewayv2_integration" "read" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "HTTP_PROXY"
  integration_uri  = "http://${var.read_service_endpoint}:8082/{proxy}"
  integration_method = "ANY"

  request_parameters = {
    # This strips the /read-service/ prefix before sending to ALB
    "overwrite:path"             = "$request.path.proxy"
    "append:header.X-Cognito-Id" = "$context.authorizer.lambda.userId"
    "append:header.X-Role"       = "$context.authorizer.lambda.role"
  }
}

# --- Routes ---

resource "aws_apigatewayv2_route" "write_proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /write-service/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.write.id}"
  
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.auth.id
}

resource "aws_apigatewayv2_route" "read_proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /read-service/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.read.id}"

  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.auth.id
}

# Removed /auth-public. Traffic funnels through /write-service/ again.

variable "project_name" {}
variable "write_service_endpoint" {}
variable "read_service_endpoint" {}
variable "authorizer_uri" {}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "execution_arn" {
  value = aws_apigatewayv2_api.main.execution_arn
}
