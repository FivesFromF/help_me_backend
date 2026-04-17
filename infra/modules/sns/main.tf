resource "aws_sns_topic" "emergency_alerts" {
  name = "${var.project_name}-emergency-alerts"
}

variable "project_name" {
  type = string
}

output "topic_arn" {
  value = aws_sns_topic.emergency_alerts.arn
}
