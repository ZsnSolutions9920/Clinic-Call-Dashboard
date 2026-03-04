<#
.SYNOPSIS
    Monitors Phone Link notifications for incoming calls and triggers the Clinicea webhook.
.NOTES
    Requirements:
    - Windows 10 version 1803+ or Windows 11
    - Phone Link app connected to your Android phone
    - Enable notification access: Settings > Privacy & Security > Notifications
    - Node.js server running (node server.js)
#>

$webhookUrl = "http://localhost:3000/incoming_call"

Write-Host ""
Write-Host "=== Phone Link Call Monitor ===" -ForegroundColor Cyan
Write-Host "Webhook: $webhookUrl" -ForegroundColor Gray
Write-Host ""

# ── Load WinRT notification types ──
try {
    [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
} catch {
    Write-Host "ERROR: Cannot load Windows notification APIs." -ForegroundColor Red
    Write-Host "Requires Windows 10 version 1803 or later." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# ── Async helper (WinRT uses async, PowerShell needs this bridge) ──
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await-AsyncOp {
    param($AsyncOp, [Type]$ResultType)
    $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($AsyncOp))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

# ── Request notification access ──
$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current

Write-Host "Requesting notification access..." -ForegroundColor Yellow
try {
    $accessStatus = Await-AsyncOp `
        ($listener.RequestAccessAsync()) `
        ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
} catch {
    Write-Host "ERROR: Failed to request notification access." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Fix: Settings > Privacy & Security > Notifications" -ForegroundColor Yellow
    Write-Host "     Enable 'Allow apps to access your notifications'" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

if ($accessStatus -ne [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
    Write-Host "ERROR: Notification access denied ($accessStatus)." -ForegroundColor Red
    Write-Host ""
    Write-Host "Fix: Settings > Privacy & Security > Notifications" -ForegroundColor Yellow
    Write-Host "     Turn ON 'Notification access'" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Access granted!" -ForegroundColor Green
Write-Host "Monitoring for incoming calls... (Ctrl+C to stop)" -ForegroundColor Green
Write-Host ""

# ── Track which notifications we've already seen ──
$seenIds = @{}
$recentCalls = @{}  # Prevent duplicate triggers for the same call

while ($true) {
    try {
        $notifications = Await-AsyncOp `
            ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) `
            ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])

        foreach ($notif in $notifications) {
            $id = $notif.Id
            if ($seenIds.ContainsKey($id)) { continue }
            $seenIds[$id] = $true

            # Get app name
            try {
                $appName = $notif.AppInfo.DisplayInfo.DisplayName
            } catch {
                continue
            }

            # Only process Phone Link notifications
            if ($appName -notmatch "Phone Link|Your Phone|Phone") { continue }

            # Read notification content
            try {
                $binding = $notif.Notification.Visual.GetBinding(
                    [Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric
                )
                if ($null -eq $binding) { continue }

                $textElements = $binding.GetTextElements()
                $allTexts = @()
                foreach ($elem in $textElements) {
                    $allTexts += $elem.Text
                }
                $fullText = $allTexts -join " "

                $ts = Get-Date -Format "HH:mm:ss"

                # Check if it's a call notification
                if ($fullText -match "incoming|call|calling|ringing|answer|decline") {
                    # Extract phone number — strip call keywords first, then clean
                    $numberPart = $fullText -replace '(?i)(incoming\s*call|calling|ringing|answer|decline|voice\s*call)', ''
                    $numberPart = $numberPart.Trim()

                    $phone = $null

                    # Match anything that looks like a phone number: +1 618-822-3636, +923001234567, 03001234567, etc.
                    if ($numberPart -match '(\+?[\d][\d\s\-\(\)]{7,18}[\d])') {
                        $phone = $Matches[1] -replace '[\s\-\(\)]', ''
                    }

                    if ($phone) {
                        # Deduplicate: don't trigger for same number within 30 seconds
                        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
                        if ($recentCalls.ContainsKey($phone) -and ($now - $recentCalls[$phone]) -lt 30) {
                            continue
                        }
                        $recentCalls[$phone] = $now

                        Write-Host "[$ts] INCOMING CALL: $phone" -ForegroundColor White -BackgroundColor DarkGreen

                        # POST to webhook
                        $body = "From=$([uri]::EscapeDataString($phone))&CallSid=local-$now"
                        try {
                            $response = Invoke-RestMethod -Uri $webhookUrl -Method POST `
                                -Body $body -ContentType "application/x-www-form-urlencoded" `
                                -TimeoutSec 5
                            Write-Host "  -> Dashboard notified! Clinicea: $($response.cliniceaUrl)" -ForegroundColor Cyan
                        } catch {
                            Write-Host "  -> Webhook error: $($_.Exception.Message)" -ForegroundColor Red
                            Write-Host "     Is the server running? (node server.js)" -ForegroundColor Yellow
                        }
                    } else {
                        Write-Host "[$ts] Call detected but could not extract number from: $fullText" -ForegroundColor Yellow
                    }
                } else {
                    # Log other Phone Link notifications (SMS, etc.) for debugging
                    Write-Host "[$ts] Phone Link: $fullText" -ForegroundColor DarkGray
                }
            } catch {
                # Skip unparseable notifications
            }
        }

        # Clean up old seen IDs (keep memory usage low)
        if ($seenIds.Count -gt 1000) {
            $seenIds = @{}
        }
        # Clean up old recent calls (older than 60s)
        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
        $expiredCalls = $recentCalls.Keys | Where-Object { ($now - $recentCalls[$_]) -gt 60 }
        foreach ($key in $expiredCalls) {
            $recentCalls.Remove($key)
        }

    } catch {
        $err = $_.Exception.Message
        if ($err -notmatch "denied|access") {
            Write-Host "[ERROR] $err" -ForegroundColor Red
        }
    }

    Start-Sleep -Seconds 1
}
