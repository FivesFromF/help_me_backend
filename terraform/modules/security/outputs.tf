output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "ecs_execution_role_arn" {
  value = aws_iam_role.ecs_execution_role.arn
}

output "ecs_task_role_arn" {
  value = aws_iam_role.ecs_task_role.arn
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}
