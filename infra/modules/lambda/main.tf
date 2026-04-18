# Audit Worker: EventBridge -> Timestream
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

resource "aws_iam_policy" "audit_timestream" {
  name = "${var.project_name}-audit-timestream-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = ["timestream:WriteRecords", "timestream:DescribeEndpoints"]
      Effect   = "Allow"
      Resource = "*"
    }]
  })

  tags = {
    Project   = "HelpMe"
    Component = "Policy-AuditTimestream"
  }
}

resource "aws_iam_role_policy_attachment" "audit_timestream_attach" {
  role       = aws_iam_role.audit_worker_role.name
  policy_arn = aws_iam_policy.audit_timestream.arn
}

resource "aws_lambda_function" "audit_worker" {
  filename      = "${path.module}/audit_worker.zip"
  function_name = "${var.project_name}-audit-worker"
  role          = aws_iam_role.audit_worker_role.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"

  environment {
    variables = {
      TIMESTREAM_DATABASE = var.timestream_db
      TIMESTREAM_TABLE    = var.timestream_table
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

  tags = {
    Project   = "HelpMe"
    Component = "IAM-NotificationRole"
  }
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

  tags = {
    Project   = "HelpMe"
    Component = "Policy-NotificationSNS"
  }
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

  tags = {
    Project   = "HelpMe"
    Component = "Lambda-Notification"
  }
}

resource "aws_lambda_permission" "notification_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notification_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_bus_arn
}

variable "project_name" {}
variable "timestream_db" {}
variable "timestream_table" {}
variable "event_bus_arn" {}
variable "sns_topic_arn" {}
variable "database_url" {}
variable "session_table_arn" {}
variable "session_table_name" {}

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

  tags = {
    Project   = "HelpMe"
    Component = "IAM-GrantRole"
  }
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
      Resource = var.session_table_arn
    }]
  })

  tags = {
    Project   = "HelpMe"
    Component = "Policy-GrantDynamoDB"
  }
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
      ACCESS_SESSIONS_TABLE = var.session_table_name
    }
  }

  lifecycle {
    ignore_changes = [filename]
  }

  tags = {
    Project   = "HelpMe"
    Component = "Lambda-Grant"
  }
}

resource "aws_lambda_permission" "grant_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.grant_permission_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_bus_arn
}

output "audit_lambda_arn" {
  value = aws_lambda_function.audit_worker.arn
}

output "notification_lambda_arn" {
  value = aws_lambda_function.notification_worker.arn
}

output "grant_permission_lambda_arn" {
  value = aws_lambda_function.grant_permission_worker.arn
}
