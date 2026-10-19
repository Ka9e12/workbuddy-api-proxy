<#
.SYNOPSIS
    WorkBuddy API Proxy — CodeBuddy 签到/成长中心定时任务管理脚本

.DESCRIPTION
    注册两个 Windows 计划任务，调用 scripts/billing-task.mjs：
    - WorkBuddyApiProxy-Checkin：每天 08:05 触发一次（签到一天一次足矣）
    - WorkBuddyApiProxy-Growth：每天 09:05 / 13:05 / 19:05 / 21:00 各触发一次
      （成长中心收益有时效：猫猫旅行几小时后带礼物回来、礼物要手动领，需一天多次轮询）

    关键设计：
    - 使用**多个独立的 -Daily 触发器**，而非"一个任务每 N 小时重复"——后者一旦遇到
      关机/睡眠错过，重复实例会被永久跳过；独立触发器配合 -StartWhenAvailable 才能错过补跑。
    - -StartWhenAvailable 实现"错过补跑"（唤醒/开机后补跑错过的触发）。
    - -ExecutionTimeLimit 30 分钟，防止挂住的任务实例占住后续触发（同名任务不并发）。
    - -WorkingDirectory 是硬要求：脚本内所有路径基于 process.cwd()。

.EXAMPLE
    .\schedule.ps1 enable    # 注册/启用定时任务（需要管理员权限）
    .\schedule.ps1 disable   # 删除定时任务
    .\schedule.ps1 status    # 查看当前状态
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
    Write-Host "[提示] 此操作需要管理员权限，正在打开一个新的管理员窗口执行..." -ForegroundColor Yellow
    # -NoExit：提权后的新窗口执行完保留，否则用户来不及看到"已注册"这类结果提示
    $arguments = '-NoProfile -ExecutionPolicy Bypass -NoExit -File "' + $PSCommandPath + '" ' + $Action
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs
    Write-Host "[提示] 请在弹出的新窗口中查看执行结果。" -ForegroundColor Yellow
    exit 0
}

if ($Action -in @("enable", "disable")) {
    Request-Elevation
}

$CheckinTask = "WorkBuddyApiProxy-Checkin"
$GrowthTask = "WorkBuddyApiProxy-Growth"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $ProjectDir "scripts\billing-task.mjs"
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodePath) {
    Write-Host "[错误] 未找到 node，请确认 Node.js 已安装并在 PATH 中" -ForegroundColor Red
    exit 1
}

function Get-TaskExists($name) {
    return $null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)
}

function Show-TaskStatus($name, $label) {
    if (Get-TaskExists $name) {
        $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
        Write-Host "[$label] 已启用" -ForegroundColor Green
        if ($info) {
            Write-Host "  上次运行: $($info.LastRunTime)  结果码: $($info.LastTaskResult)  下次运行: $($info.NextRunTime)"
        }
    } else {
        Write-Host "[$label] 未启用" -ForegroundColor Yellow
    }
}

function Show-Status {
    Show-TaskStatus $CheckinTask "签到任务"
    Show-TaskStatus $GrowthTask "成长任务"
    Write-Host "  Node路径: $NodePath"
    Write-Host "  脚本路径: $ScriptPath"
    Write-Host "  项目目录: $ProjectDir"
}

function Enable-Schedule {
    if (-not (Test-Path $ScriptPath)) {
        Write-Host "[错误] 未找到任务脚本: $ScriptPath" -ForegroundColor Red
        exit 1
    }

    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

    # 签到：每天 08:05 单触发器
    # 用单引号拼接（含内层引号）而不是反引号转义：后者容易与续行符冲突，单引号拼接更可预测。
    $CheckinAction = New-ScheduledTaskAction `
        -Execute ('"' + $NodePath + '"') `
        -Argument ('"' + $ScriptPath + '" checkin') `
        -WorkingDirectory $ProjectDir
    $CheckinTrigger = New-ScheduledTaskTrigger -Daily -At 08:05
    Register-ScheduledTask -TaskName $CheckinTask -Action $CheckinAction -Trigger $CheckinTrigger `
        -Settings $Settings -Description "CodeBuddy 每日签到" -Force | Out-Null
    Write-Host "[签到任务] 已注册（每天 08:05）" -ForegroundColor Green

    # 成长中心：多个独立触发器，每次错过都能补跑
    $GrowthAction = New-ScheduledTaskAction `
        -Execute ('"' + $NodePath + '"') `
        -Argument ('"' + $ScriptPath + '" growth') `
        -WorkingDirectory $ProjectDir
    $GrowthTriggers = @(
        (New-ScheduledTaskTrigger -Daily -At 09:05),
        (New-ScheduledTaskTrigger -Daily -At 13:05),
        (New-ScheduledTaskTrigger -Daily -At 19:05),
        (New-ScheduledTaskTrigger -Daily -At 21:00)
    )
    Register-ScheduledTask -TaskName $GrowthTask -Action $GrowthAction -Trigger $GrowthTriggers `
        -Settings $Settings -Description "CodeBuddy 成长中心日常（猫猫旅行/连登/抽奖）" -Force | Out-Null
    Write-Host "[成长任务] 已注册（每天 09:05 / 13:05 / 19:05 / 21:00）" -ForegroundColor Green

    Write-Host ""
    Write-Host ('  手动测试:  node "' + $ScriptPath + '" checkin')
    Write-Host ('             node "' + $ScriptPath + '" growth')
    Write-Host ('  查看状态:  Get-ScheduledTaskInfo -TaskName ' + $CheckinTask)
}

function Disable-Schedule {
    foreach ($name in @($CheckinTask, $GrowthTask)) {
        if (Get-TaskExists $name) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "[$name] 已删除" -ForegroundColor Green
        }
    }
}

switch ($Action) {
    "enable"  { Enable-Schedule }
    "disable" { Disable-Schedule }
    "status"  { Show-Status }
}
