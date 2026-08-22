# CloudFront in front of the ALB, purely to terminate TLS.
#
# ACM will not issue a certificate for *.elb.amazonaws.com, so an HTTPS listener on the ALB needs a
# domain we own - and this account has none (the only Route53 zone, helpme.local, is the private
# Cloud Map namespace used for ECS service discovery). CloudFront's default *.cloudfront.net name
# ships with a trusted AWS certificate, which gives real HTTPS with no domain and no cert to renew.
#
# This is a TLS front door, not a cache: the API returns per-user medical data, so every request is
# forwarded to the origin and nothing is stored. Swap the managed policies below if that changes.

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "${var.project_name} API - TLS termination in front of the ALB"
  price_class     = "PriceClass_200" # includes Asia-Pacific; PriceClass_100 does not
  http_version    = "http2"
  is_ipv6_enabled = true

  origin {
    domain_name = var.alb_dns_name
    origin_id   = "alb"

    custom_origin_config {
      http_port  = 80
      https_port = 443
      # The ALB has no certificate, so this hop is plain HTTP. It stays inside the AWS network,
      # and it is the reason to move to an ACM cert on the ALB once a domain exists.
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
  }

  default_cache_behavior {
    target_origin_id = "alb"
    # Anything arriving over http:// is bounced to https:// rather than served.
    viewer_protocol_policy = "redirect-to-https"

    # The API mutates state, so the write verbs have to be allowed through.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    # AWS managed policies:
    #   CachingDisabled  - no caching at all; every request reaches the ALB.
    #   AllViewerExceptHostHeader - forwards all headers, cookies and query strings, so
    #                      Authorization and x-cognito-id survive the hop. Without it CloudFront
    #                      strips them. "ExceptHost" is the variant AWS recommends for an ALB
    #                      origin: the ALB sees its own hostname rather than the CloudFront one.
    # IDs are fixed by AWS; confirm with `aws cloudfront list-cache-policies --type managed`.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # The free *.cloudfront.net certificate. Replace with acm_certificate_arn + aliases when a
    # real domain is registered.
    cloudfront_default_certificate = true
  }

  tags = {
    Name    = "${var.project_name}-api-cdn"
    Project = "HelpMe"
  }
}

variable "project_name" {}
variable "alb_dns_name" {}

output "domain_name" {
  value = aws_cloudfront_distribution.api.domain_name
}

output "api_url" {
  value = "https://${aws_cloudfront_distribution.api.domain_name}"
}
