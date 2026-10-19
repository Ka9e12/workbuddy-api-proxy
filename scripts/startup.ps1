<#
.SYNOPSIS
    WorkBuddy API Proxy 开机启动管理脚本

.DESCRIPTION
    启用或禁用 WorkBuddy API Proxy 服务的开机自启动。
    使用 Windows 任务计划程序实现，服务启动在 3088 端口。
    enable/disable 操作会自动请求管理员权限。

.EXAMPLE
    .\startup.ps1 enable    # 启用开机自启动
    .\startup.ps1 disable   # 禁用开机自启动
    .\startup.ps1 status    # 查看当前状态
#>

param(
    [Parameter(Position=0)]
    [ValidateSet("enable", "disable", "status")]
    [string]$Action = "status"
)

# 按需自动提权：仅 enable/disable 需要管理员权限
function Request-Elevation {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        return
    }
    Write-Host "[提示] 此操作需要管理员权限，正在请求提权..." -ForegroundColor Yellow
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Action"
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs
    exit 0
}

if ($Action -in @("enable", "disable")) {
    Request-Elevation
}

$TaskName = "WorkBuddyApiProxy"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $ProjectDir "src\index.js"
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodePath) {
    Write-Host "[错误] 未找到 node，请确认 Node.js 已安装并在 PATH 中" -ForegroundColor Red
    exit 1
}

function Get-TaskExists {
    return $null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

function Show-Status {
    if (Get-TaskExists) {
        $task = Get-ScheduledTask -TaskName $TaskName
        $state = if ($task.State -eq "Ready") { "已启用" } else { $task.State }
        Write-Host "[开机启动] 已开启 ($state)" -ForegroundColor Green
        Write-Host "  任务名称: $TaskName"
        Write-Host "  Node路径: $NodePath"
        Write-Host "  项目目录: $ProjectDir"
    } else {
        Write-Host "[开机启动] 未开启" -ForegroundColor Yellow
    }
}

function Enable-Startup {
    if (Get-TaskExists) {
        Write-Host "[开机启动] 已经是开启状态，如需重建请先 disable 再 enable" -ForegroundColor Yellow
        return
    }

    # 加载 .env 中的端口配置
    $EnvFile = Join-Path $ProjectDir ".env"
    $EnvPort = "3088"
    if (Test-Path $EnvFile) {
        $portLine = Get-Content $EnvFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' }
        if ($portLine) {
            $EnvPort = $Matches[1]
        }
    }

    $Action = New-ScheduledTaskAction -Execute "`"$NodePath`"" -Argument "--use-system-ca `"$ScriptPath`"" -WorkingDirectory $ProjectDir
    $Trigger = New-ScheduledTaskTrigger -AtLogOn
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)

    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "WorkBuddy API Proxy 服务 (端口 $EnvPort)" -Force | Out-Null

    Write-Host "[开机启动] 已开启" -ForegroundColor Green
    Write-Host "  服务将在用户登录时自动启动，监听端口 $EnvPort"
    Write-Host ""
    Write-Host "  立即启动服务:  node --use-system-ca src/index.js"
    Write-Host "  查看运行状态:  Get-ScheduledTask -TaskName $TaskName"
}

function Disable-Startup {
    if (-not (Get-TaskExists)) {
        Write-Host "[开机启动] 已经是关闭状态" -ForegroundColor Yellow
        return
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[开机启动] 已关闭" -ForegroundColor Green
}

switch ($Action) {
    "enable"  { Enable-Startup }
    "disable" { Disable-Startup }
    "status"  { Show-Status }
}
