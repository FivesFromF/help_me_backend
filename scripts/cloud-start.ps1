# AWS Cost Optimization Script - START (Wakeup)
# Usage: .\scripts\cloud-start.ps1

Write-Host "--- Initiating Cloud Wakeup Sequence ---" -ForegroundColor Yellow

$cluster = "helpme-cluster"
$writeService = "helpme-write-service"
$readService = "helpme-read-service"
$aiService = "helpme-ai-service"
$rdsInstance = "helpme-db"
$bastionId = "i-03edbd7d43f7aa022"

# 1. Start Bastion Host
Write-Host "[1/3] Starting Bastion Host ($bastionId)..." -ForegroundColor Cyan
aws ec2 start-instances --instance-ids $bastionId | Out-Null
Write-Host "    - Bastion Host starting."

# 2. Start RDS Instance
Write-Host "[2/3] Starting RDS instance ($rdsInstance)..." -ForegroundColor Cyan
aws rds start-db-instance --db-instance-identifier $rdsInstance | Out-Null
Write-Host "    - RDS start command sent. (Note: It may take 3-5 mins to become 'Available')"

# 3. Start ECS Tasks (Scale to 1)
Write-Host "[3/3] Scaling ECS services back to 1..." -ForegroundColor Cyan
aws ecs update-service --cluster $cluster --service $writeService --desired-count 1 | Out-Null
aws ecs update-service --cluster $cluster --service $readService --desired-count 1 | Out-Null
aws ecs update-service --cluster $cluster --service $aiService --desired-count 1 | Out-Null
Write-Host "    - ECS tasks scaling up."

Write-Host "--- System is waking up. Please allow 3-5 mins for DB and Backend to be fully ready. ---" -ForegroundColor Green
