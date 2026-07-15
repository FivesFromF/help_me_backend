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

resource "aws_apigatewayv2_integration" "read_service" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = var.read_lambda_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "write_service" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = var.write_lambda_arn
  payload_format_version = "2.0"
}

# --- Routes ---

resource "aws_apigatewayv2_route" "write_route" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /api/v1/write/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.write_service.id}"
  
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.auth.id
}

resource "aws_apigatewayv2_route" "read_route" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /api/v1/read/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.read_service.id}"

  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.auth.id
}

# --- Permissions to allow API Gateway to invoke Lambdas ---

resource "aws_lambda_permission" "apigw_read" {
  statement_id  = "AllowAPIGatewayInvokeReadV1"
  action        = "lambda:InvokeFunction"
  function_name = var.read_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_write" {
  statement_id  = "AllowAPIGatewayInvokeWriteV1"
  action        = "lambda:InvokeFunction"
  function_name = var.write_lambda_arn
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

variable "project_name" {}
variable "read_lambda_arn" {}
variable "write_lambda_arn" {}
variable "authorizer_uri" {}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "execution_arn" {
  value = aws_apigatewayv2_api.main.execution_arn
}
