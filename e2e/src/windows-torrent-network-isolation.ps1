param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$BunPath,
  [Parameter(Mandatory = $true, Position = 1)]
  [string]$ElectronPath,
  [Parameter(Mandatory = $true, Position = 2)]
  [string]$AttemptRunnerPath,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$AttemptArguments
)

$ErrorActionPreference = 'Stop'
$rulePrefix = "OpenGameInstaller-E2E-Torrent-$([guid]::NewGuid())"
$ruleNames = [System.Collections.Generic.List[string]]::new()
$programs = @($BunPath, $ElectronPath) | Select-Object -Unique
$exitCode = 1
$cleanupErrors = [System.Collections.Generic.List[string]]::new()

try {
  foreach ($program in $programs) {
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {
      throw "Torrent isolation program does not exist: $program"
    }
    foreach ($direction in @('Inbound', 'Outbound')) {
      $ruleName = "$rulePrefix-$direction-$($ruleNames.Count)"
      New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction $direction `
        -Action Block `
        -Enabled True `
        -Profile Any `
        -Program $program `
        -RemoteAddress Any | Out-Null
      $ruleNames.Add($ruleName)
    }
  }

  $process = Start-Process `
    -FilePath $BunPath `
    -ArgumentList (@($AttemptRunnerPath) + $AttemptArguments) `
    -NoNewWindow `
    -Wait `
    -PassThru
  $exitCode = $process.ExitCode
}
finally {
  foreach ($ruleName in $ruleNames) {
    try {
      Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction Stop
    }
    catch {
      $cleanupErrors.Add($_.Exception.Message)
    }
  }
  if ($env:OGI_TORRENT_WINDOWS_ISOLATION_EVIDENCE) {
    @{
      version = 1
      mode = 'windows-firewall-program-scope'
      programs = $programs
      rulesCreated = $ruleNames.Count
      rulesRemoved = $ruleNames.Count - $cleanupErrors.Count
      cleanupErrors = @($cleanupErrors)
      childExitCode = $exitCode
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:OGI_TORRENT_WINDOWS_ISOLATION_EVIDENCE -Encoding utf8
  }
}

if ($cleanupErrors.Count -gt 0) {
  throw "Torrent firewall cleanup failed: $($cleanupErrors -join '; ')"
}
exit $exitCode
