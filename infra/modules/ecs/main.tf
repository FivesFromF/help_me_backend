# --- ECR Repository ---
resource "aws_ecr_repository" "app" {
  name                 = "${var.project_name}-backend"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  force_delete = true
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus     = "any"
        countType     = "imageCountMoreThan"
        countNumber   = 10
      }
      action = {
        type = "expire"
      }
    }]
  })
}

# --- Security Groups ---

resource "aws_security_group" "app_tasks" {
  name        = "${var.project_name}-ecs-app-sg"
  description = "Security group for ECS app tasks"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-ecs-app-sg"
  }
}

# --- IAM Roles for ECS Express Mode ---

# Execution Role (Standard)
resource "aws_iam_role" "ecs_execution_role" {
  name = "${var.project_name}-ecs-execution-role-express"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_role_policy" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --- Timestream IAM Permissions ---
resource "aws_iam_policy" "timestream_write" {
  name        = "${var.project_name}-timestream-write-policy"
  description = "Allows ECS tasks to write audit logs to Timestream"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "timestream:WriteRecords",
          "timestream:DescribeEndpoints"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_timestream_write" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = aws_iam_policy.timestream_write.arn
}

# --- EventBridge & DynamoDB IAM Permissions ---
resource "aws_iam_policy" "ecs_cloud_access" {
  name        = "${var.project_name}-ecs-cloud-access"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = "events:PutEvents"
        Effect   = "Allow"
        Resource = var.event_bus_arn
      },
      {
        Action   = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Effect   = "Allow"
        Resource = var.session_table_arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_cloud_access_attach" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = aws_iam_policy.ecs_cloud_access.arn
}

# Infrastructure Role (Required for Express Mode)
resource "aws_iam_role" "ecs_infrastructure_role" {
  name = "${var.project_name}-ecs-infra-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs.amazonaws.com" }
    }]
  })
}

# Standard policy for ECS to manage infrastructure on behalf of the user
resource "aws_iam_role_policy_attachment" "ecs_infrastructure_role_policy" {
  role       = aws_iam_role.ecs_infrastructure_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForService"
}

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "express" {
  name              = "/ecs/${var.project_name}-express"
  retention_in_days = 7
}

# --- ECS Express Gateway Services ---

# WRITE Service
resource "aws_ecs_express_gateway_service" "write" {
  service_name            = "${var.project_name}-write"
  execution_role_arn      = aws_iam_role.ecs_execution_role.arn
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure_role.arn

  primary_container {
    image          = var.write_container_image
    container_port = 8080
    
    # Environment variables (Block format for Express Mode)
    environment {
      name  = "DATABASE_URL"
      value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme"
    }
    environment {
      name  = "TIMESTREAM_DATABASE"
      value = var.timestream_db
    }
    environment {
      name  = "TIMESTREAM_TABLE"
      value = var.timestream_table
    }
    environment {
      name  = "EVENT_BUS_NAME"
      value = var.event_bus_name
    }
    environment {
      name  = "ACCESS_SESSIONS_TABLE"
      value = var.session_table_name
    }
    environment {
      name  = "SYSTEM_SECRET"
      value = var.system_secret
    }
  }
}

# READ Service
resource "aws_ecs_express_gateway_service" "read" {
  service_name            = "${var.project_name}-read"
  execution_role_arn      = aws_iam_role.ecs_execution_role.arn
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure_role.arn

  primary_container {
    image          = var.read_container_image
    container_port = 8080

    environment {
      name  = "DATABASE_URL"
      value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme"
    }
    environment {
      name  = "TIMESTREAM_DATABASE"
      value = var.timestream_db
    }
    environment {
      name  = "TIMESTREAM_TABLE"
      value = var.timestream_table
    }
    environment {
      name  = "EVENT_BUS_NAME"
      value = var.event_bus_name
    }
    environment {
      name  = "ACCESS_SESSIONS_TABLE"
      value = var.session_table_name
    }
    environment {
      name  = "SYSTEM_SECRET"
      value = var.system_secret
    }
  }
}

# --- Variables & Outputs ---

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {}
variable "timestream_db" {}
variable "timestream_table" {}
variable "timestream_db_name" { default = "" } # Deprecated
variable "timestream_table_name" { default = "" } # Deprecated
variable "event_bus_name" {}
variable "event_bus_arn" {}
variable "read_container_image" {}
variable "write_container_image" {}
variable "session_table_name" {}
variable "session_table_arn" {}
variable "db_cluster_endpoint" {}
variable "db_password" {}
variable "system_secret" {}

output "write_service_dns" {
  value = aws_ecs_express_gateway_service.write.service_dns_name
}

output "read_service_dns" {
  value = aws_ecs_express_gateway_service.read.service_dns_name
}

output "app_tasks_sg_id" {
  value = aws_security_group.app_tasks.id
}

output "ecs_role_arn" {
  value = aws_iam_role.ecs_execution_role.arn
}
