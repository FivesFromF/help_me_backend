# --- ALB Security Group ---
resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Security group for Application Load Balancer"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP Ingress"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS Ingress"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound traffic"
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

# --- Application Load Balancer ---
resource "aws_lb" "main" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = false

  tags = {
    Name    = "${var.project_name}-alb"
    Project = "HelpMe"
  }
}

# --- Target Groups (IP target type for awsvpc Fargate tasks) ---
resource "aws_lb_target_group" "write" {
  name        = "${var.project_name}-write-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "8080"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name    = "${var.project_name}-write-tg"
    Project = "HelpMe"
  }
}

resource "aws_lb_target_group" "read" {
  name        = "${var.project_name}-read-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    port                = "8080"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name    = "${var.project_name}-read-tg"
    Project = "HelpMe"
  }
}

# --- HTTP Listener (Port 80) ---
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # Default action forwards to read service
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.read.arn
  }
}

# --- Path-Based Listener Rules ---
resource "aws_lb_listener_rule" "write_service" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.write.arn
  }

  condition {
    path_pattern {
      values = [
        "/api/v1/write/*",
        "/write-service/*",
        "/api/v1/citizen/first-declare",
        "/api/v1/citizen/medical-record/update",
        "/api/v1/citizen/nfc/*"
      ]
    }
  }
}

resource "aws_lb_listener_rule" "read_service" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.read.arn
  }

  condition {
    path_pattern {
      values = [
        "/api/v1/read/*",
        "/read-service/*",
        "/api/v1/scan*",
        "/api/v1/victim/*",
        "/api/v1/citizen/*"
      ]
    }
  }
}

# --- Variables & Outputs ---
variable "project_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

output "alb_arn" {
  value = aws_lb.main.arn
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_sg_id" {
  value = aws_security_group.alb.id
}

output "write_target_group_arn" {
  value = aws_lb_target_group.write.arn
}

output "read_target_group_arn" {
  value = aws_lb_target_group.read.arn
}