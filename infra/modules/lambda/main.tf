# Audit Worker: EventBridge -> DynamoDB (Audit Logs)
resource "aws_iam_role" "audit_worker_role" {
  name = "${var.project_name}-audit-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
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
  handler       = "index.main"
  runtime       = "nodejs20.x"

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

# Permission to be invoked by System Bus Audit Rule
resource "aws_lambda_permission" "audit_system" {
  statement_id  = "AllowSystemBusInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.audit_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.audit_system_rule_arn
}

# Permission to be invoked by Emergency Bus Audit Rule
resource "aws_lambda_permission" "audit_emergency" {
  statement_id  = "AllowEmergencyBusInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.audit_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.audit_emergency_rule_arn
}

# Notification Worker: EventBridge -> Email (SMTP)
resource "aws_iam_role" "notification_worker_role" {
  name = "${var.project_name}-notification-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_iam_role_policy_attachment" "notification_basic" {
  role       = aws_iam_role.notification_worker_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "notification_worker" {
  filename      = "${path.module}/notification_worker.zip"
  function_name = "${var.project_name}-notification-worker"
  role          = aws_iam_role.notification_worker_role.arn
  handler       = "index.main"
  runtime       = "nodejs20.x"

  environment {
    variables = {
      SMTP_HOST    = var.smtp_host
      SMTP_PORT    = var.smtp_port
      SMTP_USER    = var.smtp_user
      SMTP_PASS    = var.smtp_pass
      SMTP_FROM    = var.smtp_from
      DATABASE_URL = var.database_url
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
  statement_id  = "AllowEmergencyBusInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notification_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.identification_rule_arn
}

# grant-permission-worker was deleted on 2026-08-22. It wrote the access grant into DynamoDB until
# sessions moved to Postgres; after that it was a no-op that could not have done the job anyway,
# having no VPC configuration to reach RDS. Granting lives in read-server/routes/scan.routes.ts and
# the Python AI worker, both inside the VPC and synchronous with the scan response.

# =============================================
# Post Confirmation Lambda: Auto-add new user to 'citizen' group
# =============================================

resource "aws_iam_role" "post_confirmation_role" {
  name = "${var.project_name}-post-confirmation-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Project   = "HelpMe"
    Component = "Lambda-PostConfirmation"
  }
}

resource "aws_iam_role_policy_attachment" "post_confirmation_basic" {
  role       = aws_iam_role.post_confirmation_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "post_confirmation_cognito" {
  name = "${var.project_name}-post-confirmation-cognito-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminListGroupsForUser"
      ]
      Resource = var.user_pool_arn
    }]
  })
}

resource "aws_iam_role_policy_attachment" "post_confirmation_cognito_attach" {
  role       = aws_iam_role.post_confirmation_role.name
  policy_arn = aws_iam_policy.post_confirmation_cognito.arn
}

resource "aws_lambda_function" "post_confirmation" {
  filename      = "${path.module}/post_confirmation.zip"
  function_name = "${var.project_name}-post-confirmation"
  role          = aws_iam_role.post_confirmation_role.arn
  handler       = "index.main"
  runtime       = "nodejs20.x"

  lifecycle {
    ignore_changes = [filename]
  }

  tags = {
    Project   = "HelpMe"
    Component = "Lambda-PostConfirmation"
  }
}

resource "aws_lambda_permission" "cognito_post_confirmation" {
  statement_id  = "AllowCognitoInvokePostConfirmation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.post_confirmation.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = var.user_pool_arn
}

# --- Variables & Outputs ---

variable "project_name" {}

variable "smtp_host" {
  type = string
}

variable "smtp_port" {
  type = string
}

variable "smtp_user" {
  type = string
}

variable "smtp_pass" {
  type      = string
  sensitive = true
}

variable "smtp_from" {
  type = string
}

variable "database_url" {}
variable "user_pool_arn" {}
variable "audit_table_arn" {}
variable "audit_table_name" {}

# Bus ARNs for dual-permission
variable "audit_system_rule_arn" {}
variable "audit_emergency_rule_arn" {}
variable "identification_rule_arn" {}

# Bus name for post-authentication event publishing
variable "core_system_bus_name" {
  type    = string
  default = ""
}

output "audit_lambda_arn" {
  value = aws_lambda_function.audit_worker.arn
}

output "notification_lambda_arn" {
  value = aws_lambda_function.notification_worker.arn
}
output "post_confirmation_lambda_arn" {
  value = aws_lambda_function.post_confirmation.arn
}
