# --- ECR Repository ---
resource "aws_ecr_repository" "app" {
  name                 = "${var.project_name}-backend"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  force_delete = true

  tags = {
    Project = "HelpMe"
  }
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

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Security group for ALB"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 8081
    to_port     = 8082
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-alb-sg"
    Project = "HelpMe"
  }
}

resource "aws_security_group" "app_tasks" {
  name        = "${var.project_name}-ecs-app-sg"
  description = "Security group for ECS app tasks"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
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

# --- IAM Roles for ECS Express Mode ---

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
        # Grant access to BOTH buses
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
        Resource = "*" # Restrict to User Pool ARN if possible, but '*' is common for multi-resource Cognito tasks
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

# --- ECS Standard Infrastructure ---

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  tags = {
    Project = "HelpMe"
  }
}

# --- Application Load Balancer ---

resource "aws_lb" "main" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.subnet_ids

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_lb_target_group" "write" {
  name        = "${var.project_name}-write-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_target_group" "read" {
  name        = "${var.project_name}-read-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "write" {
  load_balancer_arn = aws_lb.main.arn
  port              = "8081"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.write.arn
  }
}

resource "aws_lb_listener" "read" {
  load_balancer_arn = aws_lb.main.arn
  port              = "8082"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.read.arn
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

# --- ECS Services (Standard Fargate) ---

# Task Definitions
resource "aws_ecs_task_definition" "write" {
  family                   = "${var.project_name}-write"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_execution_role.arn

  container_definitions = jsonencode([{
    name  = "write-app"
    image = var.write_container_image
    portMappings = [{
      containerPort = 8080
      hostPort      = 8080
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services.name
        "awslogs-region"        = "ap-southeast-1"
        "awslogs-stream-prefix" = "write"
      }
    }
    environment = [
      { name = "ACCESS_SESSIONS_TABLE", value = var.sessions_table_name },
      { name = "CORE_SYSTEM_BUS_NAME", value = var.system_bus_name },
      { name = "DATABASE_URL", value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme" },
      { name = "EMERGENCY_BUS_NAME", value = var.emergency_bus_name },
      { name = "SYSTEM_SECRET", value = var.system_secret },
      { name = "COGNITO_USER_POOL_ID", value = var.user_pool_id },
      { name = "COGNITO_CLIENT_ID", value = var.client_id },
      { name = "AUDIT_LOGS_TABLE", value = var.audit_table_name }
    ]
  }])

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_ecs_task_definition" "read" {
  family                   = "${var.project_name}-read"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_execution_role.arn

  container_definitions = jsonencode([{
    name  = "read-app"
    image = var.read_container_image
    portMappings = [{
      containerPort = 8080
      hostPort      = 8080
      protocol      = "tcp"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services.name
        "awslogs-region"        = "ap-southeast-1"
        "awslogs-stream-prefix" = "read"
      }
    }
    environment = [
      { name = "ACCESS_SESSIONS_TABLE", value = var.sessions_table_name },
      { name = "CORE_SYSTEM_BUS_NAME", value = var.system_bus_name },
      { name = "DATABASE_URL", value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme" },
      { name = "EMERGENCY_BUS_NAME", value = var.emergency_bus_name },
      { name = "SYSTEM_SECRET", value = var.system_secret },
      { name = "COGNITO_USER_POOL_ID", value = var.user_pool_id },
      { name = "COGNITO_CLIENT_ID", value = var.client_id },
      { name = "AUDIT_LOGS_TABLE", value = var.audit_table_name }
    ]
  }])

  tags = {
    Project = "HelpMe"
  }
}

# Services
resource "aws_ecs_service" "write" {
  name            = "${var.project_name}-write-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.write.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.app_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.write.arn
    container_name   = "write-app"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.write]

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_ecs_service" "read" {
  name            = "${var.project_name}-read-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.read.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.app_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.read.arn
    container_name   = "read-app"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.read]

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

# Cognito & Audit
variable "user_pool_id" {}
variable "client_id" {}
variable "audit_table_name" {}

output "write_service_endpoint" {
  value = aws_lb.main.dns_name
}

output "read_service_endpoint" {
  value = aws_lb.main.dns_name
}

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
