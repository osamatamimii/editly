# =====================================================================
#  Editly — نشر العامل على Fly، بأمر واحد.
#
#  شغّله في PowerShell:      .\deploy-worker.ps1
#
#  لا يكتب أي سرّ على القرص، ولا يطبع أيًّا منها على الشاشة، ولا يرسل
#  شيئًا إلى أي مكان غير Fly. آمن لإعادة التشغيل: كل خطوة تتخطّى نفسها
#  إن كانت قد تمّت.
# =====================================================================

$ErrorActionPreference = "Stop"
$ORG  = "osama-tamimi"
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
$env:PATH = "$HOME\.fly\bin;$env:PATH"
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Write-Host "   ...تنزيل flyctl"
  Invoke-RestMethod https://fly.io/install.ps1 -UseBasicParsing | Invoke-Expression
  $env:PATH = "$HOME\.fly\bin;$env:PATH"
}
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) { Die "لم يُثبَّت flyctl. أغلق PowerShell وافتحه من جديد ثم أعد التشغيل." }
Ok (fly version)

# --- 2. تسجيل الدخول -------------------------------------------------
Step 2 "تسجيل الدخول"
fly auth whoami 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "   سيفتح المتصفّح — وافق ثم ارجع إلى هنا."
  fly auth login
  if ($LASTEXITCODE -ne 0) { Die "فشل تسجيل الدخول." }
}
Ok ("مسجّل الدخول: " + (fly auth whoami))

# --- 3. التطبيق ------------------------------------------------------
Step 3 "التطبيق $APP"
$apps = (fly apps list 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0) { Die "الرمز لا يرى أي تطبيقات. غالبًا مشكلة صلاحيات SSO — أخبرني بالرسالة كاملة." }
if ($apps -match [regex]::Escape($APP)) {
  Ok "موجود مسبقًا — سيُعاد استخدامه."
} else {
  fly apps create $APP --org $ORG
  if ($LASTEXITCODE -ne 0) { Die "تعذّر إنشاء التطبيق. إن كانت الرسالة عن الدفع، أضف بطاقة من fly.io ثم أعد التشغيل." }
  Ok "أُنشئ."
}

# --- 4. الأسرار ------------------------------------------------------
Step 4 "الأسرار الثلاثة"
Write-Host "   الإدخال مخفيّ. لا يُطبع ولا يُحفظ."
Write-Host ""
Write-Host "   DATABASE_URL  <- انسخه من Vercel: Settings > Environment Variables > DATABASE_URL"
$dbSec = Read-Host "   DATABASE_URL" -AsSecureString
Write-Host ""
Write-Host "   SERVICE_ROLE  <- من Supabase: Settings > API Keys > service_role (Secret)"
$srSec = Read-Host "   SUPABASE_SERVICE_ROLE_KEY" -AsSecureString

$db = Reveal $dbSec
$sr = Reveal $srSec
if ([string]::IsNullOrWhiteSpace($db) -or [string]::IsNullOrWhiteSpace($sr)) { Die "أحد الحقلين فارغ." }
if ($db -notmatch "^postgres") { Die "DATABASE_URL لا يبدأ بـ postgres — تأكّد أنك نسخت القيمة لا الاسم." }
if ($db -notmatch ":6543/")    { Write-Host "   تنبيه: الرابط ليس على المنفذ 6543 (Transaction pooler). سأكمل، لكن راجعه." -ForegroundColor Yellow }

fly secrets set `
  "DATABASE_URL=$db" `
  "SUPABASE_URL=https://jszalanebxdshrwwegmg.supabase.co" `
  "SUPABASE_SERVICE_ROLE_KEY=$sr" `
  --app $APP --stage
if ($LASTEXITCODE -ne 0) { Die "تعذّر ضبط الأسرار." }
$db = $null; $sr = $null; [GC]::Collect()
Ok "ضُبطت (مرحّلة — تُفعَّل مع النشر)."

# --- 5. الكود --------------------------------------------------------
Step 5 "الكود"
$work = Join-Path $env:TEMP "editly-deploy"
if (Test-Path (Join-Path $work ".git")) {
  Push-Location $work; git fetch origin --quiet; git reset --hard origin/main --quiet; Pop-Location
  Ok "محدَّث من origin/main."
} else {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force }
  git clone --depth 1 $REPO $work
  if ($LASTEXITCODE -ne 0) { Die "تعذّر الاستنساخ. هل git مثبّت؟" }
  Ok "استُنسخ."
}

# --- 6. النشر --------------------------------------------------------
Step 6 "النشر (٣-٦ دقائق للبناء الأوّل)"
Push-Location $work
fly deploy --config artifacts/worker/fly.toml --dockerfile artifacts/worker/Dockerfile --remote-only --app $APP
$deployCode = $LASTEXITCODE
Pop-Location
if ($deployCode -ne 0) { Die "فشل النشر. إن ذكرت الرسالة payment method فأضف بطاقة على fly.io وأعد التشغيل — كل ما سبق محفوظ." }
Ok "نُشر."

# --- 7. هل هو حيّ فعلًا ----------------------------------------------
Step 7 "التحقّق"
Write-Host "   انتظار نبضة العامل..."
Start-Sleep -Seconds 20
fly status --app $APP
Write-Host ""
Write-Host "   آخر السجلّ — ابحث عن سطر 'worker ready':" -ForegroundColor Cyan
fly logs --app $APP --no-tail | Select-Object -Last 40

# --- 8. رمز للنشر التلقائي لاحقًا -------------------------------------
Step 8 "رمز GitHub Actions (اختياري)"
Write-Host "   هذا يجعل كل تعديل مستقبلي يُنشر تلقائيًّا. الرمز سيُطبع مرّة واحدة:"
Write-Host ""
fly tokens create org -o $ORG -n editly-deploy -x 8760h
Write-Host ""
Write-Host "   ضعه في GitHub > Settings > Secrets and variables > Actions > FLY_API_TOKEN" -ForegroundColor Yellow
Write-Host "   ثم أغلق هذه النافذة حتى لا يبقى الرمز معروضًا." -ForegroundColor Yellow

Write-Host ""
Write-Host "انتهى. افتح لوحة المشاريع على المنصّة: يجب أن تنتقل الحالة من" -ForegroundColor Green
Write-Host "'Waiting for a machine' إلى '0 waiting'." -ForegroundColor Green
