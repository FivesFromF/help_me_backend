variable "aws_region" {
  description = "AWS Region to deploy resources"
  type        = "string"
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Environment name used as prefix for all resources"
  type        = string
  default     = "helpme"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = "string"
  default     = "10.0.0.0/16"
}
