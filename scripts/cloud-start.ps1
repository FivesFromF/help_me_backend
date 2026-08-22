param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("all", "services", "bastion")]
    [string]$Mode = "all"
)

Write-Host "--- Initiating Cloud Wakeup Sequence ($Mode mode) ---" -ForegroundColor Yellow

$cluster = "helpme-cluster"
$writeService = "helpme-write-service"
$readService = "helpme-read-service"
$aiService = "helpme-ai-service"
$rdsInstance = "helpme-db"

# Bastion id comes from Terraform, not from a literal. It was hardcoded to i-03edbd7d43f7aa022 until
# 2026-08-23; that instance had been replaced, so start silently no-opped and cloud-stop.ps1 never
# stopped the real bastion - it ran continuously. Reading the output also makes this work in a fork.
function Get-BastionId {
    $id = terraform -chdir="$(Join-Path $PSScriptRoot '..\infra')" output -raw bastion_instance_id
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($id)) {
        Write-Host "    - Could not read bastion_instance_id from terraform output; skipping bastion." -ForegroundColor Yellow
        return $null
    }
    return $id.Trim()
}

# 1. Start Bastion Host
if ($Mode -eq "all" -or $Mode -eq "bastion") {
    $bastionId = Get-BastionId
    if ($bastionId) {
        Write-Host "[*] Starting Bastion Host ($bastionId)..." -ForegroundColor Cyan
        aws ec2 start-instances --instance-ids $bastionId | Out-Null
        Write-Host "    - Bastion Host starting."
    }
}

# 2. Start RDS Instance
if ($Mode -eq "all" -or $Mode -eq "services") {
    Write-Host "[*] Starting RDS instance ($rdsInstance)..." -ForegroundColor Cyan
    try {
        aws rds start-db-instance --db-instance-identifier $rdsInstance | Out-Null
        Write-Host "    - RDS start command sent. (Note: It may take 3-5 mins to become 'Available')"
    } catch {
        Write-Host "    - RDS instance may already be starting or available." -ForegroundColor Gray
    }
}

# 3. Start ECS Tasks (Scale to 1)
if ($Mode -eq "all" -or $Mode -eq "services") {
    Write-Host "[*] Scaling ECS services back to 1..." -ForegroundColor Cyan
    aws ecs update-service --cluster $cluster --service $writeService --desired-count 1 | Out-Null
    aws ecs update-service --cluster $cluster --service $readService --desired-count 1 | Out-Null
    aws ecs update-service --cluster $cluster --service $aiService --desired-count 1 | Out-Null
    Write-Host "    - ECS tasks scaling up."
}

if ($Mode -eq "all") {
    Write-Host "--- System is waking up. Please allow 3-5 mins for DB and Backend to be fully ready. ---" -ForegroundColor Green
} else {
    Write-Host "--- Selected components ($Mode) are waking up. ---" -ForegroundColor Green
}
