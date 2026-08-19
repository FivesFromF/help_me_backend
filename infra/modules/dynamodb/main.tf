resource "aws_dynamodb_table" "access_sessions" {
  name         = "${var.project_name}-access-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id" # staff_id#citizen_id

  attribute {
    name = "session_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Name      = "${var.project_name}-access-sessions"
    Project   = "HelpMe"
    Component = "DynamoDB-Sessions"
  }
}

resource "aws_dynamodb_table" "audit_logs" {
  name         = "${var.project_name}-audit-logs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "actor_id"
  range_key    = "timestamp"

  attribute {
    name = "actor_id"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  # Simplified for MVP: No Streams or TTL needed if DynamoDB is the only store
  stream_enabled = false

  tags = {
    Name      = "${var.project_name}-audit-logs"
    Project   = "HelpMe"
    Component = "DynamoDB-AuditLogs"
  }
}

resource "aws_dynamodb_table" "scan_jobs" {
  name         = "${var.project_name}-scan-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Name      = "${var.project_name}-scan-jobs"
    Project   = "HelpMe"
    Component = "DynamoDB-ScanJobs"
  }
}

variable "project_name" {
  type = string
}

output "sessions_table_name" {
  value = aws_dynamodb_table.access_sessions.name
}

output "sessions_table_arn" {
  value = aws_dynamodb_table.access_sessions.arn
}

output "audit_table_name" {
  value = aws_dynamodb_table.audit_logs.name
}

output "audit_table_arn" {
  value = aws_dynamodb_table.audit_logs.arn
}

output "scan_jobs_table_name" {
  value = aws_dynamodb_table.scan_jobs.name
}

output "scan_jobs_table_arn" {
  value = aws_dynamodb_table.scan_jobs.arn
}
