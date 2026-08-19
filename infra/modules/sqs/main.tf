# --- SQS Dead-Letter Queue (DLQ) ---
resource "aws_sqs_queue" "ai_jobs_dlq" {
  name                      = "${var.project_name}-ai-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days

  tags = {
    Name      = "${var.project_name}-ai-jobs-dlq"
    Project   = "HelpMe"
    Component = "SQS-AI-DLQ"
  }
}

# --- SQS AI Jobs Queue ---
resource "aws_sqs_queue" "ai_jobs" {
  name                       = "${var.project_name}-ai-jobs-queue"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 86400 # 1 day
  receive_wait_time_seconds  = 20    # Enable long polling

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ai_jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name      = "${var.project_name}-ai-jobs-queue"
    Project   = "HelpMe"
    Component = "SQS-AI-Jobs"
  }
}

# --- SQS Queue Policy for EventBridge ---
resource "aws_sqs_queue_policy" "ai_jobs" {
  queue_url = aws_sqs_queue.ai_jobs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEventBridgeToSendMessages"
        Effect    = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.ai_jobs.arn
      }
    ]
  })
}

# --- EventBridge Rule for S3 ObjectCreated Events ---
resource "aws_cloudwatch_event_rule" "s3_image_upload" {
  name        = "${var.project_name}-s3-image-upload-rule"
  description = "Routes S3 image upload events to SQS AI processing queue"

  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created"]
    detail = {
      bucket = {
        name = [var.avatars_bucket_name]
      }
      object = {
        key = [
          { prefix = "raw-uploads/" },
          { prefix = "raw-scans/" }
        ]
      }
    }
  })

  tags = {
    Name    = "${var.project_name}-s3-image-upload-rule"
    Project = "HelpMe"
  }
}

# --- EventBridge Target to SQS ---
resource "aws_cloudwatch_event_target" "s3_to_sqs" {
  rule      = aws_cloudwatch_event_rule.s3_image_upload.name
  target_id = "SendToSQS"
  arn       = aws_sqs_queue.ai_jobs.arn
}

# --- Variables & Outputs ---
variable "project_name" {
  type = string
}

variable "avatars_bucket_name" {
  type = string
}

output "queue_url" {
  value = aws_sqs_queue.ai_jobs.url
}

output "queue_arn" {
  value = aws_sqs_queue.ai_jobs.arn
}

output "dlq_arn" {
  value = aws_sqs_queue.ai_jobs_dlq.arn
}