$ErrorActionPreference = 'Stop'

$syncPaths = @(
  'public'
  'src'
  'hooks'
  'scripts'
  'test'
  'data/.gitkeep'
  'docs'
  'package.json'
  'server.mjs'
  'README.md'
  'HANDOFF.md'
  '.env.example'
  '.gitignore'
  'sync.ps1'
) | Where-Object { Test-Path -LiteralPath $_ }

git add -- $syncPaths

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host '没有需要同步的前端改动。'
  exit 0
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
git commit -m "chore: sync frontend $stamp"
git pull --rebase origin main
git push origin main
