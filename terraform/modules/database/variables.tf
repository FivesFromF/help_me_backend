variable "environment" {}
variable "vpc_id" {}
variable "private_subnets" {
  type = list(string)
}
variable "db_name" {}
variable "master_username" {}
