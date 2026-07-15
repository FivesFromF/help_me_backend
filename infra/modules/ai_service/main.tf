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

# --- IAM Role for Lambda ---
resource "aws_iam_role" "ai_lambda" {
  name = "${var.project_name}-ai-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ai_lambda_basic" {
  role       = aws_iam_role.ai_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- Lambda Function (Container Image) ---
resource "aws_lambda_function" "ai" {
  function_name = "${var.project_name}-ai-service"
  role          = aws_iam_role.ai_lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.ai.repository_url}:latest"

  memory_size = 3008 # Cấp ~3GB RAM để load PyTorch và CPU x3 sức mạnh
  timeout     = 30

  # Bỏ qua lỗi nếu image chưa có trên ECR lúc chạy TF
  lifecycle {
    ignore_changes = [image_uri]
  }

  tags = {
    Project = "HelpMe"
  }
}

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "ai" {
  name              = "/aws/lambda/${aws_lambda_function.ai.function_name}"
  retention_in_days = 7
}

# --- Variables ---
variable "project_name" {}

# --- Outputs ---
output "repository_url" {
  value = aws_ecr_repository.ai.repository_url
}

output "lambda_arn" {
  value = aws_lambda_function.ai.arn
}

output "lambda_name" {
  value = aws_lambda_function.ai.function_name
}
