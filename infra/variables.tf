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

# --- Supabase & Secrets ---
variable "supabase_db_url" {
  description = "Connection string for Supabase PostgreSQL"
  type        = string
  sensitive   = true
}

variable "ai_internal_secret" {
  description = "Secret key for communication between Lambda and AI Service"
  type        = string
  sensitive   = true
}

variable "system_secret" {
  description = "Secret key for HMAC/signing"
  type        = string
  sensitive   = true
}

# --- Deprecated (RDS/ECS) ---
variable "db_password" {
  description = "Password for RDS PostgreSQL (Deprecated)"
  type        = string
  sensitive   = true
  default     = "DEPRECATED"
}

variable "read_container_image" {
  description = "ECR image URL for the Read service (Deprecated)"
  type        = string
  default     = "DEPRECATED"
}

variable "write_container_image" {
  description = "ECR image URL for the Write service (Deprecated)"
  type        = string
  default     = "DEPRECATED"
}
