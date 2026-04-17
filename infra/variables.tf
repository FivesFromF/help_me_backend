variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "ap-southeast-1"
}

variable "project_name" {
  description = "Project name for resource tagging and naming"
  type        = string
  default     = "helpme"
}

variable "db_password" {
  description = "Password for the Aurora PostgreSQL cluster"
  type        = string
  sensitive   = true
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "read_container_image" {
  description = "Docker image for the Read Service"
  type        = string
  default     = "nginx:latest" # Placeholder
}

variable "write_container_image" {
  description = "Docker image for the Write Service"
  type        = string
  default     = "nginx:latest" # Placeholder
}

variable "system_secret" {
  description = "Secret key for HMAC hashing (NFC/QR)"
  type        = string
  sensitive   = true
}
