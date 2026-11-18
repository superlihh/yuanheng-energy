param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
$pythonExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    $bundledPython = 'C:\Users\12237\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $bundledPython) { & $bundledPython -m venv .venv } else { py -3 -m venv .venv }
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
}
$solverAvailable = & $pythonExe -c "import importlib.util; print(importlib.util.find_spec('scipy') is not None)"
if ($solverAvailable -ne 'True') {
    & $pythonExe -m pip install -r requirements.txt --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Run .venv\Scripts\python.exe -m pip install -r requirements.txt with your preferred package index.' }
}
$envFile = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($entry in Get-Content -LiteralPath $envFile) {
        if ($entry -match '^\s*((?:AI|DASHSCOPE|OPENAI)_[A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"').Trim("'"), 'Process')
        }
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'data\logs') | Out-Null
$ports = @(8001,8080)
foreach ($servicePort in $ports) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $servicePort -ErrorAction SilentlyContinue
    foreach ($ownerId in @($listener.OwningProcess | Select-Object -Unique)) {
        if (-not $ownerId) { continue }
        $running = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
        $normalCommand = ([string]$running.CommandLine).Replace('/','\')
        if (-not $normalCommand.Contains($projectRoot)) { throw "Port $servicePort is occupied by another program. It was left running." }
        if (-not $Restart) { throw 'PowerPilot is already running. To update it, run .\start.ps1 -Restart' }
        Stop-Process -Id $ownerId -ErrorAction Stop
    }
}
& javac -encoding UTF-8 -d "$projectRoot\backend-java\classes" "$projectRoot\backend-java\src\PowerOptimizerServer.java"
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed. Install JDK 21+.' }
$pythonTask = Start-Process -FilePath $pythonExe -ArgumentList "`"$projectRoot\python-service\service.py`"" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput "$projectRoot\data\logs\python.out.log" -RedirectStandardError "$projectRoot\data\logs\python.err.log" -PassThru
$javaExe = (Get-Command java -ErrorAction Stop).Source
$javaTask = Start-Process -FilePath $javaExe -ArgumentList "-cp `"$projectRoot\backend-java\classes`" PowerOptimizerServer `"$projectRoot\frontend`"" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput "$projectRoot\data\logs\java.out.log" -RedirectStandardError "$projectRoot\data\logs\java.err.log" -PassThru
@{ python=$pythonTask.Id; java=$javaTask.Id } | ConvertTo-Json | Set-Content -LiteralPath "$projectRoot\data\service-pids.json"
$ready = $false
for ($attempt=0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8080/api/health' -TimeoutSec 2
        if ($health.status -eq 'ok') { $ready=$true; break }
    } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $ready) { throw 'Startup failed. Check data\logs.' }
Write-Host 'PowerPilot is ready: http://127.0.0.1:8080'
Write-Host 'Register an account, then import data or load demo data in Data Access.'
