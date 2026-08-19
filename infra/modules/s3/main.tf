resource "aws_s3_bucket" "avatars" {
  bucket = "${var.project_name}-avatars-${var.random_suffix}"

  tags = {
    Name        = "${var.project_name}-avatars"
    Project     = var.project_name
    Environment = "production"
  }
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Ownership controls
resource "aws_s3_bucket_ownership_controls" "avatars" {
  bucket = aws_s3_bucket.avatars.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

# Bucket ACL - Private
resource "aws_s3_bucket_acl" "avatars" {
  depends_on = [aws_s3_bucket_ownership_controls.avatars]

  bucket = aws_s3_bucket.avatars.id
  acl    = "private"
}

# CORS configuration for Flutter Web/App access via presigned URLs
resource "aws_s3_bucket_cors_configuration" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = ["*"] # Adjust to specific domain if needed for production
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# Enable EventBridge notifications for S3 ObjectCreated events
resource "aws_s3_bucket_notification" "avatars_eventbridge" {
  bucket      = aws_s3_bucket.avatars.id
  eventbridge = true
}
