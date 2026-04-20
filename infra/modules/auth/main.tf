resource "aws_cognito_user_pool" "pool" {
  name = "${var.project_name}-user-pool"

  # Standard attributes
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  # Lambda Triggers
  lambda_config {
    post_confirmation = var.post_confirmation_lambda_arn
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

  depends_on = [aws_cognito_identity_provider.google]

  # Authentication flows
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_ADMIN_USER_PASSWORD_AUTH"
  ]

  supported_identity_providers = ["COGNITO", "Google"]

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"]
  allowed_oauth_scopes                 = ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"]
  callback_urls                       = ["http://localhost:3000/", "helpme://auth-callback"]
  logout_urls                         = ["http://localhost:3000/", "helpme://auth-logout"]

  # For MVP simplified auth
  generate_secret = false
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.pool.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    authorize_scopes = "email openid profile"
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    token_request_method          = "POST"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
    oidc_issuer                   = "https://accounts.google.com"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
    name     = "name"
    picture  = "picture"
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${var.project_name}-auth-${var.random_suffix}"
  user_pool_id = aws_cognito_user_pool.pool.id
}

variable "project_name" {}
variable "random_suffix" {
  default = "dev"
}

# Google OAuth
variable "google_client_id" {
  type    = string
  default = "PLACEHOLDER"
}
variable "google_client_secret" {
  type    = string
  default = "PLACEHOLDER"
  sensitive = true
}

# Post Confirmation Lambda ARN (from lambda module)
variable "post_confirmation_lambda_arn" {
  type    = string
  default = ""
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
