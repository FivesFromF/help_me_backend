resource "aws_cognito_user_pool" "pool" {
  name = "${var.project_name}-user-pool"

  # Standard attributes
  auto_verified_attributes = ["email"]
  alias_attributes = ["email", "phone_number"]

  # Lambda Triggers for Passwordless OTP
  lambda_config {
    define_auth_challenge          = var.cognito_define_auth_arn
    create_auth_challenge          = var.cognito_create_auth_arn
    verify_auth_challenge_response = var.cognito_verify_auth_arn
  }

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
    name                     = "role" # Custom role: Admin, Doctor, Staff, Citizen
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  tags = {
    Name = "${var.project_name}-user-pool"
  }
}

# --- User Groups ---

resource "aws_cognito_user_group" "admins" {
  name         = "Admins"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "System Administrators with full access"
}

resource "aws_cognito_user_group" "staff" {
  name         = "Staff"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Healthcare Staff and Doctors"
}

resource "aws_cognito_user_group" "citizens" {
  name         = "Citizens"
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "General public users"
}

resource "aws_cognito_user_pool_client" "client" {
  name = "${var.project_name}-app-client"

  user_pool_id = aws_cognito_user_pool.pool.id

  # Authentication flows
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_CUSTOM_AUTH"
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

# Lambda trigger ARNs
variable "cognito_define_auth_arn" {}
variable "cognito_create_auth_arn" {}
variable "cognito_verify_auth_arn" {}

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
