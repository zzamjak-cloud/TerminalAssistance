# 로컬에서 업데이터 서명이 포함된 릴리즈 빌드를 수행한다 (Windows / PowerShell).
#
# Tauri v2 는 서명 키를 .env 파일에서 읽지 않는다. 반드시 프로세스 환경변수로 전달해야 한다.
# 따라서 이 스크립트가 키 파일 경로를 환경변수로 세팅한 뒤 빌드를 호출한다.
#
# 사용법:
#   .\scripts\build-signed.ps1                                  # 기본 키 경로 사용
#   .\scripts\build-signed.ps1 -KeyPath C:\keys\myapp.key        # 키 경로 지정
#
# 주의: 키 파일은 저장소 밖(예: ~\.tauri\)에 두고 절대 커밋하지 않는다.

param(
    # 업데이터 서명용 minisign 개인키 파일 경로
    [string]$KeyPath = (Join-Path $HOME ".tauri\terminalassistance.key")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $KeyPath)) {
    Write-Host "개인키를 찾을 수 없습니다: $KeyPath" -ForegroundColor Red
    Write-Host ""
    Write-Host "다음 중 하나를 선택하세요:" -ForegroundColor Yellow
    Write-Host "  1) 기존 키를 해당 경로에 복사 (권장 - 기존 릴리즈와 서명 호환)"
    Write-Host "  2) 서명 없이 개발 실행만:  npm run dev"
    Write-Host ""
    Write-Host "새 키를 만들면 이전 버전 사용자가 자동 업데이트를 받지 못합니다." -ForegroundColor Yellow
    exit 1
}

# 키는 경로 또는 키 내용 문자열 둘 다 허용된다 — 여기서는 경로를 넘긴다
$env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path $KeyPath).Path

# 키에 암호가 걸려 있으면 입력받고, 없으면 빈 문자열
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $secure = Read-Host "키 암호 (없으면 Enter)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

Write-Host "서명 키: $env:TAURI_SIGNING_PRIVATE_KEY" -ForegroundColor Cyan
npm run build

# 환경변수는 이 프로세스에서만 유효하므로 별도 정리 불필요
