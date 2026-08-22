# --- ECR Repository ---
resource "aws_ecr_repository" "ai" {
  name                 = "${var.project_name}-ai-server"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  force_delete = true

  tags = {
    Project = "HelpMe"
  }
}

# --- Security Group for AI Worker (Egress Only) ---
resource "aws_security_group" "ai_tasks" {
  name        = "${var.project_name}-ecs-ai-sg"
  description = "Security group for ECS AI background worker tasks"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow all outbound traffic to SQS, S3, DynamoDB, EventBridge, and RDS"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-ecs-ai-sg"
    Project = "HelpMe"
  }
}

# --- IAM Policy for AI Worker (SQS + S3 + DynamoDB + EventBridge) ---
resource "aws_iam_policy" "ai_worker_permissions" {
  name = "${var.project_name}-ai-worker-permissions"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SQSConsumer"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ]
        Resource = [var.queue_arn]
      },
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = [
          var.avatars_bucket_arn,
          "${var.avatars_bucket_arn}/*"
        ]
      },
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem"
        ]
        Resource = [
          var.scan_jobs_table_arn,
        ]
      },
      {
        Sid    = "EventBridgePublish"
        Effect = "Allow"
        Action = [
          "events:PutEvents"
        ]
        Resource = [var.emergency_bus_arn]
      }
    ]
  })

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_iam_role_policy_attachment" "ai_worker_attach" {
  role       = var.execution_role_name != "" ? var.execution_role_name : split("/", var.execution_role_arn)[length(split("/", var.execution_role_arn)) - 1]
  policy_arn = aws_iam_policy.ai_worker_permissions.arn
}

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "ai" {
  name              = "/ecs/${var.project_name}-ai"
  retention_in_days = 7

  tags = {
    Project = "HelpMe"
  }
}

# --- ECS Task Definition (Pure SQS Worker) ---
resource "aws_ecs_task_definition" "ai" {
  family                   = "${var.project_name}-ai"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 1024 # 1 vCPU
  memory                   = 2048 # 2 GB
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.execution_role_arn

  container_definitions = jsonencode([{
    name  = "ai-app"
    image = "${aws_ecr_repository.ai.repository_url}:latest"
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ai.name
        "awslogs-region"        = "ap-southeast-1"
        "awslogs-stream-prefix" = "ai"
      }
    }
    environment = [
      { name = "PYTHONUNBUFFERED", value = "1" },
      { name = "AWS_REGION", value = "ap-southeast-1" },
      { name = "AI_JOBS_QUEUE_URL", value = var.queue_url },
      { name = "SCAN_JOBS_TABLE", value = var.scan_jobs_table_name },
      { name = "AVATARS_BUCKET", value = var.avatars_bucket_name },
      { name = "DATABASE_URL", value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme" },
      { name = "EMERGENCY_BUS_NAME", value = var.emergency_bus_name }
    ]
  }])

  tags = {
    Project = "HelpMe"
  }
}

# --- ECS Service ---
resource "aws_ecs_service" "ai" {
  name            = "${var.project_name}-ai-service"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.ai.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.ai_tasks.id]
    assign_public_ip = true
  }

  tags = {
    Project = "HelpMe"
  }
}

# --- Variables ---
variable "project_name" {}
variable "vpc_id" {}
variable "public_subnet_ids" { type = list(string) }
variable "app_tasks_sg_id" {}
variable "execution_role_arn" {}
variable "execution_role_name" {
  type    = string
  default = ""
}
variable "cluster_id" {}

# Queue & Storage Integration
variable "queue_url" {
  type    = string
  default = ""
}
variable "queue_arn" {
  type    = string
  default = ""
}
variable "scan_jobs_table_name" {
  type    = string
  default = ""
}
variable "scan_jobs_table_arn" {
  type    = string
  default = ""
}
variable "avatars_bucket_name" {
  type    = string
  default = ""
}
variable "avatars_bucket_arn" {
  type    = string
  default = ""
}
variable "db_cluster_endpoint" {
  type    = string
  default = ""
}
variable "db_password" {
  type    = string
  default = ""
}
variable "emergency_bus_name" {
  type    = string
  default = ""
}
variable "emergency_bus_arn" {
  type    = string
  default = ""
}

# --- Outputs ---
output "repository_url" {
  value = aws_ecr_repository.ai.repository_url
}