resource "aws_cognito_user_pool" "pool" {
  name = "${var.project_name}-user-pool"

  # Standard attributes
  username_attributes = ["email"]
  auto_verified_attributes = ["email"]

  # Password policy for MVP
  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_uppercase = true
    require_symbols   = false
  }

  # Custom attributes for RBAC
  schema {
    attribute_data_type      = "String"
    developer_only_attribute = false
    mutable                  = true
    name                     = "role" # Custom role: Doctor, Rescuer, Citizen
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  tags = {
    Name = "${var.project_name}-user-pool"
  }
}

resource "aws_cognito_user_pool_client" "client" {
  name = "${var.project_name}-app-client"

  user_pool_id = aws_cognito_user_pool.pool.id

  # Authentication flows
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]

  # For MVP simplified auth
  generate_secret = false
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${var.project_name}-auth-${var.random_suffix}"
  user_pool_id = aws_cognito_user_pool.pool.id
}

variable "project_name" {}
variable "random_suffix" {
  default = "dev"
}

output "user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}

output "client_id" {
  value = aws_cognito_user_pool_client.client.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.pool.arn
}

output "user_pool_endpoint" {
  value = "https://${aws_cognito_user_pool.pool.endpoint}"
}
