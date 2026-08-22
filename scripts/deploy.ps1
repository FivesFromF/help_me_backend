param (
    [Parameter(Mandatory=$true)]
    [string]$Target,

    [Parameter(Mandatory=$false)]
    [string]$Name,

    [switch]$ForceRestart = $true
)

# --- AUTO-DETECT PATHS ---
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BACKEND_ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $BACKEND_ROOT
Write-Host ">>> Working Directory: $BACKEND_ROOT" -ForegroundColor Gray

# --- CONFIGURATION ---
$PROJECT_NAME = "helpme"
$REGION = "ap-southeast-1"
$ACCOUNT_ID = "915742579310"
$ECR_URL = "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Mapping Lambda Name -> Code Directory & Zip
$LAMBDA_MAP = @{
    "authorizer"        = @{ zip = "infra/modules/authorizer/authorizer.zip"; func = "helpme-authorizer" }
    "post-confirmation" = @{ zip = "infra/modules/lambda/post_confirmation.zip"; func = "helpme-post-confirmation" }
    "audit"            = @{ zip = "infra/modules/lambda/audit_worker.zip"; func = "helpme-audit-worker" }
    "notification"     = @{ zip = "infra/modules/lambda/notification_worker.zip"; func = "helpme-notification-worker" }
}

# Mapping Service Name -> Dockerfile & Context
$SERVICE_MAP = @{
    "write" = @{ dockerfile = "src/services/write-server/Dockerfile"; context = "."; repo = "helpme-backend"; tag = "write-latest" }
    "read"  = @{ dockerfile = "src/services/read-server/Dockerfile"; context = "."; repo = "helpme-backend"; tag = "read-latest" }
    "ai"    = @{ dockerfile = "src/services/ai-server/Dockerfile"; context = "src/services/ai-server"; repo = "helpme-ai-server"; tag = "latest" }
}

# --- FUNCTIONS ---

function Build-Push-Service($svcName) {
    $cfg = $SERVICE_MAP[$svcName]
    if (-not $cfg) { Write-Error "Dịch vụ '$svcName' không hợp lệ."; return }

    Write-Host ">>> Triển khai Service: $svcName" -ForegroundColor Cyan
    
    # 1. Build Docker
    docker build -t "$($cfg.repo):$($cfg.tag)" -f "$($cfg.dockerfile)" "$($cfg.context)"
    if ($LASTEXITCODE -ne 0) { throw "Build Docker thất bại!" }

    # 2. Login ECR (chỉ làm 1 lần)
    aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_URL

    # 3. Tag & Push
    $fullImage = "$ECR_URL/$($cfg.repo):$($cfg.tag)"
    docker tag "$($cfg.repo):$($cfg.tag)" $fullImage
    docker push $fullImage

    # 4. Force Update ECS
    if ($ForceRestart) {
        Write-Host "Đang ép ECS khởi động lại dịch vụ..." -ForegroundColor Yellow
        aws ecs update-service --cluster "$PROJECT_NAME-cluster" --service "$PROJECT_NAME-$svcName-service" --force-new-deployment --region $REGION
    }
}

function Build-Push-Lambda($lmbName) {
    $cfg = $LAMBDA_MAP[$lmbName]
    if (-not $cfg) { Write-Error "Lambda '$lmbName' không hợp lệ. Chọn: $($LAMBDA_MAP.Keys -join ', ')"; return }

    Write-Host ">>> Triển khai Lambda: $lmbName" -ForegroundColor Cyan

    # 1. Bundle TypeScript Lambdas
    Write-Host "Đang bundle TypeScript Lambdas..."
    node build.js
    if ($LASTEXITCODE -ne 0) { throw "Bundle Lambdas thất bại!" }

    # 2. CLI Update
    $zipPath = $cfg.zip
    if (-not (Test-Path $zipPath)) { throw "Không tìm thấy file ZIP: $zipPath" }

    Write-Host "Đang cập nhật code lên AWS Lambda ($($cfg.func))..." -ForegroundColor Yellow
    aws lambda update-function-code --function-name "$($cfg.func)" --zip-file "fileb://$zipPath" --region $REGION

    Write-Host "Triển khai Lambda $lmbName thành công!" -ForegroundColor Green
}

# --- MAIN LOGIC ---

try {
    # Check if Target is a specific service
    if ($SERVICE_MAP.ContainsKey($Target)) {
        Build-Push-Service $Target
    }
    # Check if Target is a specific lambda
    elseif ($LAMBDA_MAP.ContainsKey($Target)) {
        Build-Push-Lambda $Target
    }
    else {
        switch ($Target) {
            "all" {
                Write-Host "!!! ĐANG TRIỂN KHAI TOÀN BỘ HỆ THỐNG !!!" -ForegroundColor Magenta
                node build.js
                foreach ($s in $SERVICE_MAP.Keys) { Build-Push-Service $s }
                cd infra
                terraform apply -auto-approve
            }
            "service" {
                if (-not $Name) { throw "Thiếu tham số -Name (write|read|ai)" }
                Build-Push-Service $Name
            }
            "lambda" {
                if (-not $Name) { throw "Thiếu tham số -Name (authorizer|post-confirmation|audit|notification|grant)" }
                Build-Push-Lambda $Name
            }
            default {
                Write-Error "Tham số -Target '$Target' không hợp lệ."
            }
        }
    }
} catch {
    Write-Error $_
}
