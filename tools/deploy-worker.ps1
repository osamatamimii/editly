# =====================================================================
#  Editly - deploy the render worker to Fly.io.
#
#  Run:   powershell -ExecutionPolicy Bypass -File deploy-worker.ps1
#
#  No secret is written to disk, printed, or sent anywhere except Fly.
#  Safe to re-run: every step skips itself if it is already done.
#
#  ASCII only, on purpose. Windows PowerShell 5.1 reads .ps1 files as
#  ANSI unless they carry a BOM, so non-ASCII comments come back as
#  mojibake and break the parser before a single line runs.
# =====================================================================

# Continue, not Stop. Windows PowerShell turns ANYTHING a native command writes
# to stderr into a terminating error when this is "Stop" - and flyctl, git, and
# curl all write ordinary progress and status text there. Exit codes are the
# real signal, so every step below checks $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
$ORG  = "personal"   # the slug from `fly orgs list`, NOT the name in the dashboard URL
$APP  = "editly-worker"
$REPO = "https://github.com/osamatamimii/editly"

function Step($n, $t) { Write-Host ""; Write-Host "== $n. $t" -ForegroundColor Cyan }
function Ok($t)       { Write-Host "   OK  $t" -ForegroundColor Green }
function Die($t)      { Write-Host ""; Write-Host "!! $t" -ForegroundColor Red; exit 1 }

function Reveal($secure) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($p) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

# --- 1. flyctl -------------------------------------------------------
Step 1 "flyctl"
$env:PATH = "$HOME\.fly\bin;" + $env:PATH
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Write-Host "   downloading flyctl..."
  Invoke-RestMethod https://fly.io/install.ps1 -UseBasicParsing | Invoke-Expression
  $env:PATH = "$HOME\.fly\bin;" + $env:PATH
}
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Die "flyctl was not installed. Close PowerShell, open it again, and re-run this script."
}
Ok (fly version)

# --- 2. sign in ------------------------------------------------------
Step 2 "sign in"
$who = (fly auth whoami 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Write-Host "   Not signed in yet. A browser window will open - approve it, then come back here."
  fly auth login
  if ($LASTEXITCODE -ne 0) { Die "Sign-in failed." }
  $who = (fly auth whoami 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Die "Signed in, but flyctl still cannot confirm who you are." }
}
Ok ("signed in as $who")

# --- 3. the app ------------------------------------------------------
Step 3 "app $APP"
$apps = (fly apps list 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  Die "This token cannot list apps. Likely an SSO/permissions problem - send me the full message."
}
if ($apps -match [regex]::Escape($APP)) {
  Ok "already exists, reusing it."
} else {
  fly apps create $APP --org $ORG
  if ($LASTEXITCODE -ne 0) {
    Die "Could not create the app. If the message mentions a payment method, add a card on fly.io and re-run."
  }
  Ok "created."
}

# --- 4. the three secrets --------------------------------------------
Step 4 "secrets"
Write-Host "   Input is hidden on purpose: you will NOT see what you paste."
Write-Host "   Paste, then press Enter."
Write-Host ""
Write-Host "   DATABASE_URL  <- Vercel tab: Settings > Environment Variables > DATABASE_URL (click the eye)"
$dbSec = Read-Host "   DATABASE_URL" -AsSecureString
Write-Host ""
Write-Host "   SERVICE ROLE  <- Supabase tab: Settings > API Keys > service_role (the one marked Secret)"
$srSec = Read-Host "   SUPABASE_SERVICE_ROLE_KEY" -AsSecureString

$db = Reveal $dbSec
$sr = Reveal $srSec
if ([string]::IsNullOrWhiteSpace($db) -or [string]::IsNullOrWhiteSpace($sr)) { Die "One of the two was empty." }
if ($db -notmatch "^postgres") { Die "DATABASE_URL does not start with 'postgres' - you may have copied the name instead of the value." }
if ($db -notmatch ":6543/")    { Write-Host "   NOTE: that URL is not on port 6543 (transaction pooler). Continuing, but check it." -ForegroundColor Yellow }

fly secrets set `
  "DATABASE_URL=$db" `
  "SUPABASE_URL=https://jszalanebxdshrwwegmg.supabase.co" `
  "SUPABASE_SERVICE_ROLE_KEY=$sr" `
  --app $APP --stage
if ($LASTEXITCODE -ne 0) { Die "Could not set secrets." }
$db = $null; $sr = $null; [GC]::Collect()
Ok "staged - they activate with the deploy."

# --- 5. the code -----------------------------------------------------
Step 5 "code"
$work = Join-Path $env:TEMP "editly-deploy"
if (Test-Path (Join-Path $work ".git")) {
  Push-Location $work
  git fetch origin --quiet 2>&1 | Out-Null
  git reset --hard origin/main --quiet 2>&1 | Out-Null
  Pop-Location
  Ok "updated from origin/main."
} else {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force }
  git clone --depth 1 $REPO $work 2>&1 | Write-Host
  if ($LASTEXITCODE -ne 0) { Die "Clone failed. Is git installed? Get it from git-scm.com" }
  Ok "cloned."
}

# --- 6. deploy -------------------------------------------------------
Step 6 "deploy (3-6 minutes for the first build)"
Push-Location $work
fly deploy --config artifacts/worker/fly.toml --dockerfile artifacts/worker/Dockerfile --remote-only --app $APP
$deployCode = $LASTEXITCODE
Pop-Location
if ($deployCode -ne 0) {
  Die "Deploy failed. If it mentions a payment method, add a card on fly.io and re-run - everything above is saved."
}
Ok "deployed."

# --- 7. is it actually alive -----------------------------------------
Step 7 "check"
Write-Host "   waiting for the worker heartbeat..."
Start-Sleep -Seconds 20
fly status --app $APP
Write-Host ""
Write-Host "   Last log lines - look for 'worker ready':" -ForegroundColor Cyan
fly logs --app $APP --no-tail | Select-Object -Last 40

# --- 8. a token for automatic deploys later --------------------------
Step 8 "GitHub Actions token (optional)"
Write-Host "   This makes every future change deploy by itself. Printed once:"
Write-Host ""
fly tokens create org -o $ORG -n editly-deploy -x 8760h
Write-Host ""
Write-Host "   Put it in GitHub > Settings > Secrets and variables > Actions > FLY_API_TOKEN" -ForegroundColor Yellow
Write-Host "   Then close this window so the token stops being on screen." -ForegroundColor Yellow

Write-Host ""
Write-Host "Done. Open the projects page on the platform: the status should move from" -ForegroundColor Green
Write-Host "'Waiting for a machine' to '0 waiting'." -ForegroundColor Green
