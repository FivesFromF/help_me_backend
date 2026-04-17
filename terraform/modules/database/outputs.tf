output "db_cluster_endpoint" {
  value = aws_rds_cluster.postgresql.endpoint
}

output "db_cluster_reader_endpoint" {
  value = aws_rds_cluster.postgresql.reader_endpoint
}

output "s3_bucket_name" {
  value = aws_s3_bucket.media.id
}

output "opensearch_collection_endpoint" {
  value = aws_opensearchserverless_collection.vector_db.collection_endpoint
}

output "timestream_database_name" {
  value = aws_timestreamwrite_database.audit.database_name
}

output "timestream_table_name" {
  value = aws_timestreamwrite_table.logs.table_name
}
