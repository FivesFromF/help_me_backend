# Aurora Serverless v2 Cluster
resource "aws_rds_cluster" "postgresql" {
  cluster_identifier      = "${var.environment}-aurora"
  engine                  = "aurora-postgresql"
  engine_mode             = "provisioned" # Needed for Serverless v2
  engine_version          = "15.4"
  database_name           = var.db_name
  master_username         = var.master_username
  manage_master_user_password = true
  
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  
  skip_final_snapshot     = true

  serverless_v2_scaling_configuration {
    max_capacity = 2.0
    min_capacity = 0.5
  }
}

resource "aws_rds_cluster_instance" "instance" {
  cluster_identifier = aws_rds_cluster.postgresql.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgresql.engine
  engine_version     = aws_rds_cluster.postgresql.engine_version
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.environment}-db-subnet-group"
  subnet_ids = var.private_subnets

  tags = {
    Name = "${var.environment}-db-subnet-group"
  }
}

resource "aws_security_group" "db" {
  name        = "${var.environment}-db-sg"
  description = "Security group for database"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"] # Restricted to VPC
  }

  tags = {
    Name = "${var.environment}-db-sg"
  }
}

# S3 Bucket for Media
resource "aws_s3_bucket" "media" {
  bucket = "${var.environment}-media-storage"
  
  force_destroy = true # Only for dev
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
