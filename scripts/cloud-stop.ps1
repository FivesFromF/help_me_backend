param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("all", "services", "bastion")]
    [string]$Mode = "all"
)

Write-Host "--- Initiating Cloud Hibernation Sequence ($Mode mode) ---" -ForegroundColor Yellow

$cluster = "helpme-cluster"
$writeService = "helpme-write-service"
$readService = "helpme-read-service"
$aiService = "helpme-ai-service"
$rdsInstance = "helpme-db"
$bastionId = "i-03edbd7d43f7aa022"

# 1. Stop ECS Tasks (Scale to 0)
if ($Mode -eq "all" -or $Mode -eq "services") {
    Write-Host "[*] Scaling ECS services to 0..." -ForegroundColor Cyan
    aws ecs update-service --cluster $cluster --service $writeService --desired-count 0 | Out-Null
    aws ecs update-service --cluster $cluster --service $readService --desired-count 0 | Out-Null
    aws ecs update-service --cluster $cluster --service $aiService --desired-count 0 | Out-Null
    Write-Host "    - ECS tasks stopped."
}

# 2. Stop RDS Instance
if ($Mode -eq "all" -or $Mode -eq "services") {
    Write-Host "[*] Stopping RDS instance ($rdsInstance)..." -ForegroundColor Cyan
    try {
        aws rds stop-db-instance --db-instance-identifier $rdsInstance | Out-Null
        Write-Host "    - RDS stop command sent. (Note: It may take a few minutes to transition to 'Stopped')"
    } catch {
        Write-Host "    - RDS instance could not be stopped. It might already be stopping or in an invalid state." -ForegroundColor Gray
    }
}

# 3. Stop Bastion Host
if ($Mode -eq "all" -or $Mode -eq "bastion") {
    Write-Host "[*] Stopping Bastion Host ($bastionId)..." -ForegroundColor Cyan
    aws ec2 stop-instances --instance-ids $bastionId | Out-Null
    Write-Host "    - Bastion Host stopping."
}

Write-Host "--- Selection ($Mode) is hibernating. ---" -ForegroundColor Green
