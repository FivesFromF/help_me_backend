# Simplified Cloud Hibernation for Serverless Hybrid Architecture
Write-Host "--- Initiating AI Service Hibernation ---" -ForegroundColor Yellow

$cluster = "helpme-cluster"
$aiService = "helpme-ai-service"

Write-Host "[*] Scaling AI service to 0..." -ForegroundColor Cyan
aws ecs update-service --cluster $cluster --service $aiService --desired-count 0 | Out-Null

Write-Host "    - AI task stopped. Zero cost for AI compute while hibernated."
Write-Host "--- Note: Database and Backend remain online (Zero cost if idle). ---" -ForegroundColor Green
