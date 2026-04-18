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
        Resource = var.event_bus_arn
      },
      {
        Action   = [
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Effect   = "Allow"
        Resource = var.sessions_table_arn
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

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_iam_role_policy" "ecs_infrastructure_role_policy" {
  name = "${var.project_name}-ecs-infra-inline-policy"
  role = aws_iam_role.ecs_infrastructure_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "ec2:CreateSecurityGroup",
          "ec2:Describe*",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:DeleteSecurityGroup",
          "ec2:CreateTags",
          "elasticloadbalancing:*",
          "application-autoscaling:*",
          "servicediscovery:*",
          "route53:ChangeResourceRecordSets",
          "route53:GetHealthCheck",
          "route53:UpdateHealthCheck",
          "logs:DescribeLogGroups",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "express" {
  name              = "/ecs/${var.project_name}-express"
  retention_in_days = 7

  tags = {
    Project = "HelpMe"
  }
}

# --- ECS Express Gateway Services ---

# WRITE Service
resource "aws_ecs_express_gateway_service" "write" {
  service_name            = "${var.project_name}-write"
  execution_role_arn      = aws_iam_role.ecs_execution_role.arn
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure_role.arn

  cpu    = 256
  memory = 512

  primary_container {
    image          = var.write_container_image
    container_port = 8080
    
    environment {
      name  = "DATABASE_URL"
      value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme"
    }
    environment {
      name  = "EVENT_BUS_NAME"
      value = var.event_bus_name
    }
    environment {
      name  = "ACCESS_SESSIONS_TABLE"
      value = var.sessions_table_name
    }
    environment {
      name  = "SYSTEM_SECRET"
      value = var.system_secret
    }
  }

  tags = {
    Project   = "HelpMe"
    Component = "WriteService"
  }
}

# READ Service
resource "aws_ecs_express_gateway_service" "read" {
  service_name            = "${var.project_name}-read"
  execution_role_arn      = aws_iam_role.ecs_execution_role.arn
  infrastructure_role_arn = aws_iam_role.ecs_infrastructure_role.arn

  cpu    = 256
  memory = 512

  primary_container {
    image          = var.read_container_image
    container_port = 8080

    environment {
      name  = "DATABASE_URL"
      value = "postgres://adminuser:${var.db_password}@${var.db_cluster_endpoint}:5432/helpme"
    }
    environment {
      name  = "EVENT_BUS_NAME"
      value = var.event_bus_name
    }
    environment {
      name  = "ACCESS_SESSIONS_TABLE"
      value = var.sessions_table_name
    }
    environment {
      name  = "SYSTEM_SECRET"
      value = var.system_secret
    }
  }

  tags = {
    Project   = "HelpMe"
    Component = "ReadService"
  }
}

# --- Variables & Outputs ---

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {}
variable "event_bus_name" {}
variable "event_bus_arn" {}
variable "read_container_image" {}
variable "write_container_image" {}
variable "sessions_table_name" {}
variable "sessions_table_arn" {}
variable "db_cluster_endpoint" {}
variable "db_password" {}
variable "system_secret" {}

output "write_service_endpoint" {
  value = aws_ecs_express_gateway_service.write.ingress_paths[0].endpoint
}

output "read_service_endpoint" {
  value = aws_ecs_express_gateway_service.read.ingress_paths[0].endpoint
}

output "app_tasks_sg_id" {
  value = aws_security_group.app_tasks.id
}
