# AWS Cost Optimization Script - STOP (Hibernate)
# Usage: .\scripts\cloud-stop.ps1

Write-Host "--- Initiating Cloud Hibernation Sequence ---" -ForegroundColor Yellow

$cluster = "helpme-cluster"
$writeService = "helpme-write-service"
$readService = "helpme-read-service"
$aiService = "helpme-ai-service"
$rdsInstance = "helpme-db"
$bastionId = "i-03edbd7d43f7aa022"

# 1. Stop ECS Tasks (Scale to 0)
Write-Host "[1/3] Scaling ECS services to 0..." -ForegroundColor Cyan
aws ecs update-service --cluster $cluster --service $writeService --desired-count 0 | Out-Null
aws ecs update-service --cluster $cluster --service $readService --desired-count 0 | Out-Null
aws ecs update-service --cluster $cluster --service $aiService --desired-count 0 | Out-Null
Write-Host "    - ECS tasks stopped."

# 2. Stop RDS Instance
Write-Host "[2/3] Stopping RDS instance ($rdsInstance)..." -ForegroundColor Cyan
aws rds stop-db-instance --db-instance-identifier $rdsInstance | Out-Null
Write-Host "    - RDS stop command sent. (Note: It may take a few minutes to transition to 'Stopped')"

# 3. Stop Bastion Host
Write-Host "[3/3] Stopping Bastion Host ($bastionId)..." -ForegroundColor Cyan
aws ec2 stop-instances --instance-ids $bastionId | Out-Null
Write-Host "    - Bastion Host stopping."

Write-Host "--- All cost-generating services are hibernating. ---" -ForegroundColor Green
