$ErrorActionPreference = 'Stop'

git add -- public package.json server.mjs README.md sync.ps1

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host '没有需要同步的前端改动。'
  exit 0
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
git commit -m "chore: sync frontend $stamp"
git pull --rebase origin main
git push origin main

