resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-private-subnet-group"
  subnet_ids = var.subnet_ids

  tags = {
    Name    = "${var.project_name}-db-subnet-group"
    Project = "HelpMe"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "Security group for PostgreSQL RDS"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_tasks_sg_id]
  }

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.bastion_sg_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-rds-sg"
    Project = "HelpMe"
  }
}

resource "aws_db_instance" "main" {
  identifier            = "${var.project_name}-db"
  engine                = "postgres"
  engine_version        = "16"
  instance_class        = "db.t4g.micro"
  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"

  db_name  = "helpme"
  username = "adminuser"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  publicly_accessible = false
  skip_final_snapshot = true
  apply_immediately   = true

  # Multi-AZ with a single standby: RDS keeps a synchronous copy in a second availability zone and
  # fails over to it automatically. The standby is NOT readable - it serves no queries. That is the
  # difference from a read replica, and the reason both servers share one endpoint below.
  multi_az = true

  # Required for Multi-AZ, and the provider default here is 0 (disabled).
  backup_retention_period = 7

  tags = {
    Project = "HelpMe"
  }
}

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {}
variable "db_password" {}
variable "app_tasks_sg_id" {}
variable "bastion_sg_id" {}

output "cluster_endpoint" {
  value = aws_db_instance.main.address
}

# Exposed so callers can attach further 5432 ingress without editing this module — see the
# ai_tasks_to_rds rule in infra/main.tf. Adding that ingress here instead would make rds depend on
# ai_service, which already depends on rds for the endpoint: a module cycle.
output "security_group_id" {
  value = aws_security_group.rds.id
}
