<#
  Deploy the HelpMe backend (TypeScript Lambdas + Python AI Lambda container).
  This is the deployment path for the project (there is no CI workflow).

  Usage:
    ./scripts/deploy.ps1                 # build Lambdas + AI image, then terraform apply
    ./scripts/deploy.ps1 -Service ai     # only rebuild & roll the AI Lambda image
    ./scripts/deploy.ps1 -Service lambda # only rebuild JS bundles + terraform apply
    ./scripts/deploy.ps1 -SkipApply      # build/push only, no terraform

  Requires: Node 20+, Docker, Terraform, AWS CLI (configured), and infra/terraform.tfvars.
#>
param(
    [ValidateSet("all", "lambda", "ai")]
    [string]$Service = "all",
    [switch]$SkipApply
)

$ErrorActionPreference = "Stop"
$region      = "ap-southeast-1"
$aiRepo      = "helpme-ai-service"
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir     = Split-Path -Parent $scriptDir
$infraDir    = Join-Path $rootDir "infra"
$aiSourceDir = Join-Path $rootDir "src\functions\ai-service"

Write-Host "--- HelpMe deploy ($Service) ---" -ForegroundColor Yellow

$accountId = (aws sts get-caller-identity --query Account --output text)
if (-not $accountId) {
    Write-Host "[!] Could not resolve AWS account. Run 'aws configure' / SSO login first." -ForegroundColor Red
    exit 1
}
$ecrRegistry = "$accountId.dkr.ecr.$region.amazonaws.com"
$aiImage     = "$ecrRegistry/${aiRepo}:latest"

function Build-Lambdas {
    Write-Host "[*] Building TypeScript Lambda bundles (node build.js)..." -ForegroundColor Cyan
    Push-Location $rootDir
    try {
        npm ci
        node build.js
    } finally {
        Pop-Location
    }
}

function Deploy-AI {
    Write-Host "[*] Building & pushing AI Lambda image..." -ForegroundColor Cyan
    aws ecr get-login-password --region $region | docker login --username AWS --password-stdin $ecrRegistry
    docker build -t $aiImage $aiSourceDir
    docker push $aiImage
    Write-Host "    - Pushed $aiImage" -ForegroundColor Green

    # Roll the running function if it already exists (image_uri is pinned in Terraform).
    aws lambda get-function --function-name $aiRepo *> $null
    if ($LASTEXITCODE -eq 0) {
        aws lambda update-function-code --function-name $aiRepo --image-uri $aiImage | Out-Null
        Write-Host "    - Rolled $aiRepo to new image" -ForegroundColor Green
    }
}

# --- Execution ---
if ($Service -eq "all" -or $Service -eq "lambda") { Build-Lambdas }

if (-not $SkipApply) {
    Write-Host "[*] terraform init..." -ForegroundColor Cyan
    terraform -chdir="$infraDir" init
}

if ($Service -eq "all" -or $Service -eq "ai") {
    # The AI Lambda is a container image, so its ECR repo must exist before the
    # docker push (and hold an image before the Lambda can be created). Create
    # just the repo first via a targeted apply, then push.
    if (-not $SkipApply) {
        Write-Host "[*] Ensuring AI ECR repo exists (targeted apply)..." -ForegroundColor Cyan
        terraform -chdir="$infraDir" apply -auto-approve -target="module.ai_service.aws_ecr_repository.ai"
    }
    Deploy-AI
}

if (-not $SkipApply) {
    Write-Host "[*] terraform apply..." -ForegroundColor Cyan
    terraform -chdir="$infraDir" apply -auto-approve
}

Write-Host "--- Deploy complete ---" -ForegroundColor Green
