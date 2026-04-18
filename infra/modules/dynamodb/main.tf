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
    Name    = "${var.project_name}-access-sessions"
    Project = "HelpMe"
  }
}

variable "project_name" {
  type = string
}

output "table_name" {
  value = aws_dynamodb_table.access_sessions.name
}

output "table_arn" {
  value = aws_dynamodb_table.access_sessions.arn
}
