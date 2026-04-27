param(
    [Parameter(Mandatory = $false)]
    [ValidateSet("all", "read", "write", "ai")]
    [string]$Service = "all"
)

$projectName = "helpme"
$region = "ap-southeast-1"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $scriptDir
$lambdaDest = Join-Path $rootDir "infra\modules\lambda"

Write-Host "--- Initiating HelpMe Deployment Sequence ($Service) ---" -ForegroundColor Yellow

# Fetch AWS Account ID automatically
$accountId = (aws sts get-caller-identity --query Account --output text)
if (-not $accountId) {
    Write-Host "[!] Could not fetch AWS Account ID. Please ensure AWS CLI is configured." -ForegroundColor Red
    exit
}

function Build-Lambda([string]$name, [string]$path) {
    Write-Host "[*] Building Lambda Service: $name..." -ForegroundColor Cyan
    $env:GOOS = "linux"
    $env:GOARCH = "amd64"
    $env:CGO_ENABLED = "0"
    
    $absPath = Join-Path $rootDir $path
    cd $absPath
    
    go build -o bootstrap main.go
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    - Build successful. Zipping..."
        $zipPath = Join-Path $lambdaDest "$($name)_service.zip"
        Compress-Archive -Path bootstrap -DestinationPath $zipPath -Force
        Remove-Item bootstrap
        Write-Host "    - Package ready: $zipPath" -ForegroundColor Green
    } else {
        Write-Host "    - Build Failed for $name!" -ForegroundColor Red
    }
    cd $rootDir
}

function Deploy-AI() {
    Write-Host "[*] Building AI Service Docker Image..." -ForegroundColor Cyan
    $repoName = "$($projectName)-ai-service"
    $ecrUrl = "$($accountId).dkr.ecr.$($region).amazonaws.com/$($repoName)"
    
    # 1. Login to ECR
    Write-Host "    - Logging in to ECR..."
    aws ecr get-login-password --region $region | docker login --username AWS --password-stdin "$($accountId).dkr.ecr.$($region).amazonaws.com"
    
    # 2. Build Docker Image (Using src as context)
    Write-Host "    - Building image..."
    $srcPath = Join-Path $rootDir "src"
    cd $srcPath
    docker build -t $repoName -f cmd/ai-service/Dockerfile .
    
    # 3. Tag and Push
    Write-Host "    - Tagging and Pushing to $ecrUrl..."
    docker tag "$($repoName):latest" "$($ecrUrl):latest"
    docker push "$($ecrUrl):latest"
    
    Write-Host "    - AI Service deployed to ECR." -ForegroundColor Green
    cd $rootDir
}

# --- Execution ---

if ($Service -eq "all" -or $Service -eq "read") {
    Build-Lambda "read" "src\cmd\read-service"
}

if ($Service -eq "all" -or $Service -eq "write") {
    Build-Lambda "write" "src\cmd\write-service"
}

if ($Service -eq "all" -or $Service -eq "ai") {
    Deploy-AI
}

Write-Host "--- Deployment Sequence Completed ---" -ForegroundColor Green
Write-Host "Reminder: Run 'terraform apply' in 'infra' folder to update infrastructure." -ForegroundColor Yellow
