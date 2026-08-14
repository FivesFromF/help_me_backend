resource "aws_iam_role" "authorizer_role" {
  name = "${var.project_name}-authorizer-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.authorizer_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "authorizer" {
  filename      = "${path.module}/authorizer.zip"
  function_name = "${var.project_name}-authorizer"
  role          = aws_iam_role.authorizer_role.arn
  handler       = "bootstrap" # For Go AL2023
  runtime       = "provided.al2023"

  environment {
    variables = {
      USER_POOL_ID      = var.user_pool_id
      APP_CLIENT_ID     = var.client_id
      COGNITO_ENDPOINT  = var.user_pool_endpoint
    }
  }

  source_code_hash = filebase64sha256("${path.module}/authorizer.zip")
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/*/*"
}

variable "project_name" {}
variable "user_pool_id" {}
variable "client_id" {}
variable "user_pool_endpoint" {}
variable "api_execution_arn" {}

output "authorizer_uri" {
  value = aws_lambda_function.authorizer.invoke_arn
}

output "authorizer_id" {
  value = aws_lambda_function.authorizer.id
}
