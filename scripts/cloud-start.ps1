# Simplified Cloud Management for Serverless Hybrid Architecture
Write-Host "--- Initiating AI Service Startup ---" -ForegroundColor Yellow

$cluster = "helpme-cluster"
$aiService = "helpme-ai-service"

Write-Host "[*] Scaling AI service to 1..." -ForegroundColor Cyan
aws ecs update-service --cluster $cluster --service $aiService --desired-count 1 | Out-Null

Write-Host "    - AI task is scaling up. It will be ready in ~1 minute."
Write-Host "--- Database (Supabase) and Backend (Lambda) are ALWAYS ONLINE. ---" -ForegroundColor Green
