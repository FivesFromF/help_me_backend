resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnet-group"
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
  identifier           = "${var.project_name}-db"
  engine               = "postgres"
  engine_version       = "16.1"
  instance_class       = "db.t4g.micro"
  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type         = "gp3"
  
  db_name              = "helpme"
  username             = "adminuser"
  password             = var.db_password
  
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  
  publicly_accessible  = false
  skip_final_snapshot  = true
  apply_immediately    = true

  tags = {
    Project = "HelpMe"
  }
}

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {}
variable "db_password" {}
variable "app_tasks_sg_id" {}

output "cluster_endpoint" {
  value = aws_db_instance.main.address
}
