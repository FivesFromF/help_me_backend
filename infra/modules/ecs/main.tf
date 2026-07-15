# --- ECR Repository (Legacy backend removed) ---

# --- Security Groups ---

# --- Security Groups ---

# ALB Security Group removed as ALB is being deleted

resource "aws_security_group" "app_tasks" {
  name        = "${var.project_name}-ecs-app-sg"
  description = "Security group for ECS app tasks"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    cidr_blocks     = ["0.0.0.0/0"] # Protected by X-HelpMe-Secret at application level
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-ecs-app-sg"
    Project = "HelpMe"
  }
}

# --- IAM Roles for ECS ---
# ... (keeping existing roles) ...

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

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_execution_role_policy" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_policy" "ecs_cloud_access" {
  name        = "${var.project_name}-ecs-cloud-access"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = "events:PutEvents"
        Effect   = "Allow"
        Resource = [var.system_bus_arn, var.emergency_bus_arn]
      },
      {
        Action   = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Effect   = "Allow"
        Resource = var.sessions_table_arn
      },
      {
        Action   = [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminLinkProviderForUser",
          "cognito-idp:AdminAddUserToGroup"
        ]
        Effect   = "Allow"
        Resource = "*"
      },
      {
        Action   = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Effect   = "Allow"
        Resource = ["${var.avatars_bucket_arn}", "${var.avatars_bucket_arn}/*"]
      }
    ]
  })

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_cloud_access_attach" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = aws_iam_policy.ecs_cloud_access.arn
}

# --- ECS Cluster ---

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  tags = {
    Project = "HelpMe"
  }
}


# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "services" {
  name              = "/ecs/${var.project_name}-services"
  retention_in_days = 7

  tags = {
    Project = "HelpMe"
  }
}

# --- Variables & Outputs ---

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {}
variable "system_bus_name" {}
variable "system_bus_arn" {}
variable "emergency_bus_name" {}
variable "emergency_bus_arn" {}
variable "read_container_image" {}
variable "write_container_image" {}
variable "sessions_table_name" {}
variable "sessions_table_arn" {}
variable "db_cluster_endpoint" {}
variable "db_password" {}
variable "system_secret" {}
variable "service_discovery_namespace_id" {}
variable "lambda_proxy_sg_id" {}

# Cognito & Audit
variable "user_pool_id" {}
variable "client_id" {}
variable "audit_table_name" {}

variable "avatars_bucket_name" {}
variable "avatars_bucket_arn" {}

# ALB Outputs removed

output "app_tasks_sg_id" {
  value = aws_security_group.app_tasks.id
}

output "cluster_id" {
  value = aws_ecs_cluster.main.id
}

output "execution_role_arn" {
  value = aws_iam_role.ecs_execution_role.arn
}

variable "ai_server_url" {
  type    = string
  default = "http://ai.helpme.local:8000"
}
