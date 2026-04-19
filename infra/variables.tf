variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "help-me"
}

# --- Google OAuth Credentials ---
variable "google_client_id" {
  description = "Google OAuth Client ID"
  type        = string
  default     = "PLACEHOLDER"
}

variable "google_client_secret" {
  description = "Google OAuth Client Secret"
  type        = string
  default     = "PLACEHOLDER"
  sensitive   = true
}

# --- SMTP Configuration ---
variable "smtp_host" {
  description = "SMTP Host (e.g., smtp.gmail.com)"
  type        = string
}

variable "smtp_port" {
  description = "SMTP Port"
  type        = string
}

variable "smtp_user" {
  description = "SMTP Username"
  type        = string
}

variable "smtp_pass" {
  description = "SMTP Password"
  type        = string
  sensitive   = true
}

variable "smtp_from" {
  description = "Email address for sending notifications"
  type        = string
}
