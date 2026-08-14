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

# Mapping Lambda Name -> Code Directory & Main File
$LAMBDA_MAP = @{
    "authorizer"        = @{ dir = "cmd/authorizer"; binary = "bootstrap" }
    "post-confirmation" = @{ dir = "cmd/post-confirmation"; binary = "bootstrap" }
    "audit"            = @{ dir = "cmd/audit-worker"; binary = "bootstrap" }
    "notification"     = @{ dir = "cmd/notification-worker"; binary = "bootstrap" }
    "grant"            = @{ dir = "cmd/grant-permission-worker"; binary = "bootstrap" }
}

# Mapping Service Name -> Dockerfile
$SERVICE_MAP = @{
    "write" = @{ dockerfile = "cmd/write-server/Dockerfile"; repo = "helpme-backend"; tag = "write-latest" }
    "read"  = @{ dockerfile = "cmd/read-server/Dockerfile"; repo = "helpme-backend"; tag = "read-latest" }
    "ai"    = @{ dockerfile = "cmd/ai-server/Dockerfile"; repo = "helpme-ai-server"; tag = "latest" }
}

# --- FUNCTIONS ---

function Build-Push-Service($svcName) {
    $cfg = $SERVICE_MAP[$svcName]
    if (-not $cfg) { Write-Error "Dịch vụ '$svcName' không hợp lệ."; return }

    Write-Host ">>> Triển khai Service: $svcName" -ForegroundColor Cyan
    
    # 1. Build Docker
    docker build -t "$($cfg.repo):$($cfg.tag)" -f "src/$($cfg.dockerfile)" src/
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

    # 1. Build Go for Linux
    $env:GOOS = "linux"
    $env:GOARCH = "amd64"
    $binaryPath = "src/$($cfg.binary)"
    Write-Host "Đang build Go binary cho Linux..."
    go build -o $binaryPath "src/$($cfg.dir)/main.go"
    if ($LASTEXITCODE -ne 0) { throw "Build Go thất bại!" }

    # 2. Zip
    $zipPath = "src/$lmbName.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath }
    Compress-Archive -Path $binaryPath -DestinationPath $zipPath

    # 3. CLI Update (Siêu nhanh)
    Write-Host "Đang cập nhật code lên AWS Lambda..." -ForegroundColor Yellow
    aws lambda update-function-code --function-name "$PROJECT_NAME-$lmbName" --zip-file "fileb://$zipPath" --region $REGION

    # Cleanup
    Remove-Item $binaryPath
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
} finally {
    # Reset GOOS/GOARCH tránh ảnh hưởng các phiên sau
    $env:GOOS = ""
    $env:GOARCH = ""
}
