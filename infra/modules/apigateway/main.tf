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
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.project_name}-authorizer"
  
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
}

# --- Integrations ---

resource "aws_apigatewayv2_integration" "write" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "HTTP_PROXY"
  integration_uri  = var.write_service_endpoint
  integration_method = "ANY"
  
  request_parameters = {
    "overwrite:path" = "$request.path.proxy"
  }
}

resource "aws_apigatewayv2_integration" "read" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "HTTP_PROXY"
  integration_uri  = var.read_service_endpoint
  integration_method = "ANY"

  request_parameters = {
    "overwrite:path" = "$request.path.proxy"
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
