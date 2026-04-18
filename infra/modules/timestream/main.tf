resource "aws_timestreamwrite_database" "audit" {
  database_name = "${var.project_name}-audit"

  tags = {
    Project = "HelpMe"
  }
}

resource "aws_timestreamwrite_table" "audit_logs" {
  database_name = aws_timestreamwrite_database.audit.database_name
  table_name    = "audit_logs"

  retention_properties {
    memory_store_retention_period_in_hours  = 24
    magnetic_store_retention_period_in_days = 365
  }

  tags = {
    Name    = "${var.project_name}-audit-logs"
    Project = "HelpMe"
  }
}

variable "project_name" {
  type = string
}

output "database_name" {
  value = aws_timestreamwrite_database.audit.database_name
}

output "table_name" {
  value = aws_timestreamwrite_table.audit_logs.table_name
}
