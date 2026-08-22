# 1. Core System Bus: Consent, Data Access, CRUD Logs
resource "aws_cloudwatch_event_bus" "system" {
  name = "${var.project_name}-core-system-bus"
}

# 2. Emergency Bus: Scanning cases (Face/NFC/QR)
resource "aws_cloudwatch_event_bus" "emergency" {
  name = "${var.project_name}-emergency-bus"
}

# --- AUDIT RULES (Triggered from BOTH buses) ---

# Rule on System Bus for Auditing
resource "aws_cloudwatch_event_rule" "audit_system" {
  name           = "${var.project_name}-audit-system-rule"
  description    = "Capture all events from System Bus for auditing"
  event_bus_name = aws_cloudwatch_event_bus.system.name

  event_pattern = jsonencode({
    source = [{ prefix = "" }] # Match anything
  })
}

resource "aws_cloudwatch_event_target" "audit_system_target" {
  rule           = aws_cloudwatch_event_rule.audit_system.name
  event_bus_name = aws_cloudwatch_event_bus.system.name
  target_id      = "AuditLambdaSystem"
  arn            = var.audit_lambda_arn
}

# Rule on Emergency Bus for Auditing
resource "aws_cloudwatch_event_rule" "audit_emergency" {
  name           = "${var.project_name}-audit-emergency-rule"
  description    = "Capture all events from Emergency Bus for auditing"
  event_bus_name = aws_cloudwatch_event_bus.emergency.name

  event_pattern = jsonencode({
    source = [{ prefix = "" }] # Match anything
  })
}

resource "aws_cloudwatch_event_target" "audit_emergency_target" {
  rule           = aws_cloudwatch_event_rule.audit_emergency.name
  event_bus_name = aws_cloudwatch_event_bus.emergency.name
  target_id      = "AuditLambdaEmergency"
  arn            = var.audit_lambda_arn
}

# --- OPERATIONAL RULES (Only on Emergency Bus) ---

# Rule: Victim Identified
resource "aws_cloudwatch_event_rule" "identification" {
  name           = "${var.project_name}-identification-rule"
  description    = "Capture victim identification events for notifications"
  event_bus_name = aws_cloudwatch_event_bus.emergency.name

  event_pattern = jsonencode({
    "detail-type" = ["victim.identified"]
  })
}

resource "aws_cloudwatch_event_target" "notification_lambda" {
  rule           = aws_cloudwatch_event_rule.identification.name
  event_bus_name = aws_cloudwatch_event_bus.emergency.name
  target_id      = "NotificationLambda"
  arn            = var.notification_lambda_arn
}


# Removed 2026-08-22: the GrantLambda target invoked grant-permission-worker, which had been a no-op
# since access sessions moved to Postgres. The identification rule keeps notification_lambda above,
# so it still has a live target.

# --- Variables & Outputs ---

variable "project_name" {}
variable "audit_lambda_arn" {}
variable "notification_lambda_arn" {}

output "system_bus_name" {
  value = aws_cloudwatch_event_bus.system.name
}

output "system_bus_arn" {
  value = aws_cloudwatch_event_bus.system.arn
}

output "emergency_bus_name" {
  value = aws_cloudwatch_event_bus.emergency.name
}

output "emergency_bus_arn" {
  value = aws_cloudwatch_event_bus.emergency.arn
}

output "audit_system_rule_arn" {
  value = aws_cloudwatch_event_rule.audit_system.arn
}

output "audit_emergency_rule_arn" {
  value = aws_cloudwatch_event_rule.audit_emergency.arn
}

output "identification_rule_arn" {
  value = aws_cloudwatch_event_rule.identification.arn
}
