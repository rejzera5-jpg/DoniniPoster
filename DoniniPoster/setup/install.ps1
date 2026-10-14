# Установка Donini Poster: всё ставится внутрь папки программы, в систему ничего не прописывается.
param([switch]$Silent)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root "python"
Write-Host ""
Write-Host "=== Установка Donini Poster ===" -ForegroundColor Yellow
Write-Host "Папка: $root"
Write-Host "Это займёт 2-5 минут. Не закрывайте окно."
Write-Host ""

try {
    if (-not (Test-Path (Join-Path $py "python.exe"))) {
        Write-Host "[1/5] Скачиваю Python..."
        $zip = Join-Path $env:TEMP "dp-python.zip"
        Invoke-WebRequest "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip" -OutFile $zip
        Expand-Archive $zip -DestinationPath $py -Force
        Remove-Item $zip
    } else { Write-Host "[1/5] Python уже есть" }

    # разрешаем библиотеки и папку программы
    $pth = Get-ChildItem $py -Filter "python*._pth" | Select-Object -First 1
    $lines = Get-Content $pth.FullName | ForEach-Object { if ($_ -match "^#\s*import site") { "import site" } else { $_ } }
    if (-not ($lines -contains "..")) { $lines += ".." }
    Set-Content -Path $pth.FullName -Value $lines -Encoding ASCII

    $python = Join-Path $py "python.exe"
    if (-not (Test-Path (Join-Path $py "Scripts\pip.exe"))) {
        Write-Host "[2/5] Ставлю pip..."
        $gp = Join-Path $env:TEMP "dp-get-pip.py"
        Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile $gp
        & $python $gp --no-warn-script-location | Out-Null
        Remove-Item $gp
    } else { Write-Host "[2/5] pip уже есть" }

    Write-Host "[3/5] Ставлю библиотеки (fastapi, playwright, pillow)..."
    & $python -m pip install --no-warn-script-location -q --prefer-binary -r (Join-Path $root "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "pip не смог установить библиотеки" }
    # окно программы (Windows-окно на движке Edge WebView2). Не получится — программа откроется в браузере
    & $python -m pip install --no-warn-script-location -q --prefer-binary setuptools wheel
    & $python -m pip install --no-warn-script-location -q --prefer-binary --no-build-isolation pywebview
    if ($LASTEXITCODE -ne 0) { Write-Host "    (окно программы не установилось - будет открываться в браузере)" -ForegroundColor DarkYellow }

    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LocalAppData\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) {
        Write-Host "[4/5] Найден Google Chrome - программа будет использовать его"
    } else {
        Write-Host "[4/5] Chrome не найден - скачиваю встроенный браузер..."
        & $python -m playwright install chromium
    }

    Write-Host "[5/5] Создаю ярлык на рабочем столе..."
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Donini Poster.lnk"))
    $lnk.TargetPath = Join-Path $py "pythonw.exe"
    $lnk.Arguments = "`"$(Join-Path $root 'run.pyw')`""
    $lnk.WorkingDirectory = $root
    $ico = Join-Path $root "app\web\icon.ico"
    if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
    $lnk.Save()
    # автозапуск вместе с Windows программа включает сама (Настройки → «Программа»)

    Set-Content -Path (Join-Path $py ".installed") -Value (Get-Date)
    Write-Host ""
    Write-Host "Готово! Сейчас откроется окно программы." -ForegroundColor Green
    Start-Sleep -Seconds 2
    exit 0
}
catch {
    Write-Host ""
    Write-Host "Ошибка установки: $_" -ForegroundColor Red
    Write-Host "Проверьте интернет и запустите Запуск.bat ещё раз. Если не помогает - пришлите скриншот этого окна."
    exit 1
}
