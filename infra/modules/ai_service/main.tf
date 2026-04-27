# --- ECR Repository ---
resource "aws_ecr_repository" "ai" {
  name                 = "${var.project_name}-ai-service"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  force_delete = true

  tags = {
    Project = "HelpMe"
  }
}

# --- Security Group ---
resource "aws_security_group" "ai_tasks" {
  name        = "${var.project_name}-ecs-ai-sg"
  description = "Security group for ECS AI tasks"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    # OPEN ACCESS: Protected by Application-Level Secret Header (X-HelpMe-Secret)
    cidr_blocks     = ["0.0.0.0/0"]
  }

  egress {
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

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "ai" {
  name              = "/ecs/${var.project_name}-ai"
  retention_in_days = 7

  tags = {
    Project = "HelpMe"
  }
}

# --- ECS Task Definition (STANDARD Mode) ---
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
    portMappings = [{
      containerPort = 8000
      hostPort      = 8000
      protocol      = "tcp"
    }]
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
      { name = "AI_INTERNAL_SECRET", value = var.ai_internal_secret }
    ]
  }])

  tags = {
    Project = "HelpMe"
  }
}

# --- ECS Service (FARGATE Standard) ---
resource "aws_ecs_service" "ai" {
  name            = "${var.project_name}-ai-service"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.ai.arn
  desired_count   = 1
  launch_type     = "FARGATE" # Forced to Standard Fargate

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.ai_tasks.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.ai.arn
  }

  propagate_tags = "SERVICE"
}

# --- Cloud Map Service Registration ---
resource "aws_service_discovery_service" "ai" {
  name = "ai" # Resulting DNS: ai.helpme.local

  dns_config {
    namespace_id = var.service_discovery_namespace_id

    dns_records {
      ttl  = 60
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
  }
}

# --- Variables ---
variable "project_name" {}
variable "vpc_id" {}
variable "public_subnet_ids" { type = list(string) }
variable "app_tasks_sg_id" {}
variable "execution_role_arn" {}
variable "cluster_id" {}
variable "service_discovery_namespace_id" {}
variable "ai_internal_secret" {}

# --- Outputs ---
output "repository_url" {
  value = aws_ecr_repository.ai.repository_url
}
