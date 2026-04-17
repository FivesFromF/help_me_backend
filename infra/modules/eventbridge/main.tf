resource "aws_cloudwatch_event_bus" "main" {
  name = "helpme-emergency-bus"
}

# Rule: All events for Auditing
resource "aws_cloudwatch_event_rule" "audit" {
  name           = "${var.project_name}-audit-rule"
  description    = "Capture all events for auditing"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    source = [{ prefix = "" }] # Match anything
  })
}

resource "aws_cloudwatch_event_target" "audit_lambda" {
  rule           = aws_cloudwatch_event_rule.audit.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "AuditLambda"
  arn            = var.audit_lambda_arn
}

# Rule: Victim Identified for Notifications
resource "aws_cloudwatch_event_rule" "identification" {
  name           = "${var.project_name}-identification-rule"
  description    = "Capture victim identification events for notifications"
  event_bus_name = aws_cloudwatch_event_bus.main.name

  event_pattern = jsonencode({
    "detail-type" = ["victim.identified"]
  })
}

resource "aws_cloudwatch_event_target" "notification_lambda" {
  rule           = aws_cloudwatch_event_rule.identification.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "NotificationLambda"
  arn            = var.notification_lambda_arn
}

resource "aws_cloudwatch_event_target" "grant_lambda" {
  rule           = aws_cloudwatch_event_rule.identification.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "GrantLambda"
  arn            = var.grant_permission_lambda_arn
}

variable "project_name" {}
variable "audit_lambda_arn" {}
variable "notification_lambda_arn" {}
variable "grant_permission_lambda_arn" {}

output "bus_name" {
  value = aws_cloudwatch_event_bus.main.name
}

output "bus_arn" {
  value = aws_cloudwatch_event_bus.main.arn
}
