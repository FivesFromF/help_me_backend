# Audit Worker: EventBridge -> DynamoDB (Audit Logs)
resource "aws_iam_role" "audit_worker_role" {
  name = "${var.project_name}-audit-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Project   = "HelpMe"
    Component = "IAM-AuditRole"
  }
}

resource "aws_iam_role_policy_attachment" "audit_basic" {
  role       = aws_iam_role.audit_worker_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "audit_dynamodb_write" {
  name = "${var.project_name}-audit-dynamodb-write-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "dynamodb:PutItem"
      Effect   = "Allow"
      Resource = var.audit_table_arn
    }]
  })

  tags = {
    Project   = "HelpMe"
    Component = "Policy-AuditDynamoDB"
  }
}

resource "aws_iam_role_policy_attachment" "audit_dynamodb_attach" {
  role       = aws_iam_role.audit_worker_role.name
  policy_arn = aws_iam_policy.audit_dynamodb_write.arn
}

resource "aws_lambda_function" "audit_worker" {
  filename      = "${path.module}/audit_worker.zip"
  function_name = "${var.project_name}-audit-worker"
  role          = aws_iam_role.audit_worker_role.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"

  environment {
    variables = {
      AUDIT_TABLE_NAME = var.audit_table_name
    }
  }

  lifecycle {
    ignore_changes = [filename]
  }

  tags = {
    Project   = "HelpMe"
    Component = "Lambda-Audit"
  }
}

resource "aws_lambda_permission" "audit_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.audit_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_bus_arn
}

# Notification Worker: EventBridge -> SNS
resource "aws_iam_role" "notification_worker_role" {
  name = "${var.project_name}-notification-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "notification_basic" {
  role       = aws_iam_role.notification_worker_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "notification_sns" {
  name = "${var.project_name}-notification-sns-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "sns:Publish"
      Effect   = "Allow"
      Resource = var.sns_topic_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "notification_sns_attach" {
  role       = aws_iam_role.notification_worker_role.name
  policy_arn = aws_iam_policy.notification_sns.arn
}

resource "aws_lambda_function" "notification_worker" {
  filename      = "${path.module}/notification_worker.zip"
  function_name = "${var.project_name}-notification-worker"
  role          = aws_iam_role.notification_worker_role.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"

  environment {
    variables = {
      SNS_TOPIC_ARN = var.sns_topic_arn
      DATABASE_URL  = var.database_url
    }
  }

  lifecycle {
    ignore_changes = [filename]
  }
}

resource "aws_lambda_permission" "notification_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notification_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_bus_arn
}

# Grant Permission Worker: EventBridge -> DynamoDB
resource "aws_iam_role" "grant_permission_worker_role" {
  name = "${var.project_name}-grant-permission-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "grant_basic" {
  role       = aws_iam_role.grant_permission_worker_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "grant_dynamodb" {
  name = "${var.project_name}-grant-dynamodb-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "dynamodb:PutItem"
      Effect   = "Allow"
      Resource = var.sessions_table_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "grant_dynamodb_attach" {
  role       = aws_iam_role.grant_permission_worker_role.name
  policy_arn = aws_iam_policy.grant_dynamodb.arn
}

resource "aws_lambda_function" "grant_permission_worker" {
  filename      = "${path.module}/grant_permission_worker.zip"
  function_name = "${var.project_name}-grant-permission-worker"
  role          = aws_iam_role.grant_permission_worker_role.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"

  environment {
    variables = {
      ACCESS_SESSIONS_TABLE = var.sessions_table_name
    }
  }

  lifecycle {
    ignore_changes = [filename]
  }
}

resource "aws_lambda_permission" "grant_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.grant_permission_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_bus_arn
}

# --- Variables & Outputs ---

variable "project_name" {}
variable "event_bus_arn" {}
variable "sns_topic_arn" {}
variable "database_url" {}
variable "sessions_table_arn" {}
variable "sessions_table_name" {}
variable "audit_table_arn" {}
variable "audit_table_name" {}

output "audit_lambda_arn" {
  value = aws_lambda_function.audit_worker.arn
}

output "notification_lambda_arn" {
  value = aws_lambda_function.notification_worker.arn
}

output "grant_permission_lambda_arn" {
  value = aws_lambda_function.grant_permission_worker.arn
}
