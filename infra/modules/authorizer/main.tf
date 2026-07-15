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

data "archive_file" "authorizer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../../../dist/authorizer"
  output_path = "${path.module}/authorizer.zip"
}

resource "aws_lambda_function" "authorizer" {
  filename         = data.archive_file.authorizer_zip.output_path
  source_code_hash = data.archive_file.authorizer_zip.output_base64sha256
  function_name    = "${var.project_name}-authorizer"
  role             = aws_iam_role.authorizer_role.arn
  handler          = "index.main"
  runtime          = "nodejs20.x"

  environment {
    variables = {
      USER_POOL_ID      = var.user_pool_id
      APP_CLIENT_ID     = var.client_id
      COGNITO_ENDPOINT  = var.user_pool_endpoint
    }
  }
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
