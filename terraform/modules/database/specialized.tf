# OpenSearch Serverless Collection
resource "aws_opensearchserverless_collection" "vector_db" {
  name        = "${var.environment}-vectors"
  type        = "VECTORSEARCH"
  description = "Vector storage for face embeddings"

  depends_on = [
    aws_opensearchserverless_security_policy.encryption,
    aws_opensearchserverless_network_policy.network
  ]
}

# Encryption Policy
resource "aws_opensearchserverless_security_policy" "encryption" {
  name = "${var.environment}-encryption"
  type = "encryption"
  policy = jsonencode({
    Rules = [
      {
        Resource = ["collection/${var.environment}-vectors"]
        ResourceType = "collection"
      }
    ]
    AWSOwnedKey = true
  })
}

# Network Policy (Public for now, can be restricted to VPC)
resource "aws_opensearchserverless_network_policy" "network" {
  name = "${var.environment}-network"
  type = "network"
  policy = jsonencode([
    {
      Rules = [
        {
          Resource = ["collection/${var.environment}-vectors"]
          ResourceType = "collection"
        }
      ]
      AllowFromPublic = true
    }
  ])
}

# Data Access Policy
resource "aws_opensearchserverless_access_policy" "access" {
  name = "${var.environment}-access"
  type = "data"
  policy = jsonencode([
    {
      Rules = [
        {
          Resource = ["collection/${var.environment}-vectors"]
          Permission = [
            "aoss:CreateCollectionItems",
            "aoss:DeleteCollectionItems",
            "aoss:UpdateCollectionItems",
            "aoss:DescribeCollectionItems"
          ]
          ResourceType = "collection"
        },
        {
          Resource = ["index/${var.environment}-vectors/*"]
          Permission = [
            "aoss:CreateIndex",
            "aoss:DeleteIndex",
            "aoss:UpdateIndex",
            "aoss:DescribeIndex",
            "aoss:ReadDocument",
            "aoss:WriteDocument"
          ]
          ResourceType = "index"
        }
      ]
      Principal = [
        # Principal will be added once ECS Task Role is available
        "*" 
      ]
    }
  ])
}

# Timestream Database & Table
resource "aws_timestreamwrite_database" "audit" {
  database_name = "${var.environment}-audit-db"
}

resource "aws_timestreamwrite_table" "logs" {
  database_name = aws_timestreamwrite_database.audit.database_name
  table_name    = "audit-logs"

  retention_properties {
    memory_store_retention_period_in_hours = 24
    magnetic_store_retention_period_in_days = 365
  }
}
