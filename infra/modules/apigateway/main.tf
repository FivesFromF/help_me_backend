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
  api_id          = aws_apigatewayv2_api.main.id
  authorizer_type = "REQUEST"
  authorizer_uri  = var.authorizer_uri
  name            = "${var.project_name}-authorizer"

  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  authorizer_result_ttl_in_seconds  = 0
}

# --- VPC Link for Direct Private ECS Routing (No ALB) ---

resource "aws_security_group" "vpc_link" {
  name        = "${var.project_name}-vpc-link-sg"
  description = "Security group for API Gateway VPC Link"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-vpc-link-sg"
    Project = "HelpMe"
  }
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${var.project_name}-vpc-link"
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = var.subnet_ids

  tags = {
    Name    = "${var.project_name}-vpc-link"
    Project = "HelpMe"
  }
}

# --- Integrations ---

resource "aws_apigatewayv2_integration" "write" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_uri    = var.write_service_discovery_arn
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id

  request_parameters = {
    "overwrite:path"             = "$request.path.proxy"
    "append:header.X-Cognito-Id" = "$context.authorizer.userId"
    "append:header.X-Role"       = "$context.authorizer.role"
  }
}

resource "aws_apigatewayv2_integration" "read" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_uri    = var.read_service_discovery_arn
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id

  request_parameters = {
    "overwrite:path"             = "$request.path.proxy"
    "append:header.X-Cognito-Id" = "$context.authorizer.userId"
    "append:header.X-Role"       = "$context.authorizer.role"
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

# --- Variables & Outputs ---

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {
  type = list(string)
}
variable "write_service_discovery_arn" {}
variable "read_service_discovery_arn" {}
variable "authorizer_uri" {}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "execution_arn" {
  value = aws_apigatewayv2_api.main.execution_arn
}

output "vpc_link_sg_id" {
  value = aws_security_group.vpc_link.id
}