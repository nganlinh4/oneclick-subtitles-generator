#requires -Version 7.2

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$subject = Join-Path $PSScriptRoot "dev-cache.ps1"
$suiteRoot = Join-Path ([IO.Path]::GetTempPath()) ("osg-dev-cache-tests-{0}" -f [Guid]::NewGuid().ToString("N"))
$script:passed = 0
$script:failed = 0
$script:junctions = [Collections.Generic.List[string]]::new()

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Assert-False {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Condition) { throw $Message }
}

function Assert-Contains {
    param(
        [AllowEmptyString()][string]$Actual,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Actual.Contains($Expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Message`nExpected to find: $Expected`nActual: $Actual"
    }
}

function Invoke-CacheManager {
    param([Parameter(Mandatory)][hashtable]$Parameters)

    try {
        $lines = @(& $subject @Parameters *>&1)
        return [pscustomobject]@{
            Succeeded = $true
            Output = ($lines | Out-String)
            Error = $null
        }
    }
    catch {
        return [pscustomobject]@{
            Succeeded = $false
            Output = ((@($_) + @($_.ScriptStackTrace)) | Out-String)
            Error = $_
        }
    }
}

function Assert-Succeeds {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Result.Succeeded) {
        throw "$Message`n$($Result.Output)"
    }
}

function Assert-FailsWith {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Result.Succeeded) {
        throw "$Message`nThe command unexpectedly succeeded:`n$($Result.Output)"
    }
    Assert-Contains -Actual $Result.Output -Expected $Text -Message $Message
}

function Invoke-Test {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Body
    )
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name" -ForegroundColor Green
    }
    catch {
        $script:failed++
        Write-Host "FAIL $Name" -ForegroundColor Red
        Write-Host $_
    }
}

function New-TestCacheRoot {
    param([Parameter(Mandatory)][string]$Name)

    $root = Join-Path $suiteRoot "$Name\cache"
    $result = Invoke-CacheManager @{
        Action = "Path"
        Lane = "dev"
        CacheRoot = $root
    }
    Assert-Succeeds $result "Could not initialize test cache '$Name'."
    return $root
}

function Get-ManagedPath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Lane
    )

    $result = Invoke-CacheManager @{
        Action = "Path"
        Lane = $Lane
        CacheRoot = $Root
    }
    Assert-Succeeds $result "Could not resolve lane '$Lane'."
    return $result.Output.Trim()
}

function Add-Payload {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Lane,
        [Parameter(Mandatory)][string]$Name,
        [int]$Bytes = 4096,
        [int]$AgeDays = 0
    )

    $lanePath = Get-ManagedPath -Root $Root -Lane $Lane
    if ($Lane -eq "runtime") {
        $fill = if ($Name.Length -gt 0) { [int][char]$Name[0] % 16 } else { 10 }
        $payloadRoot = Join-Path $lanePath (("{0:x}" -f $fill) * 64)
        New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
    }
    elseif ($Lane -eq "evidence" -or $Lane -eq "staging") {
        $payloadRoot = Join-Path $lanePath $Name
        New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
    }
    else {
        $payloadRoot = $lanePath
    }
    $payloadPath = Join-Path $payloadRoot "$Name.bin"
    [IO.File]::WriteAllBytes($payloadPath, [byte[]]::new($Bytes))
    $timestamp = [DateTime]::UtcNow.AddDays(-$AgeDays)
    [IO.File]::SetLastWriteTimeUtc($payloadPath, $timestamp)
    if ($payloadRoot -ne $lanePath) {
        [IO.Directory]::SetLastWriteTimeUtc($payloadRoot, $timestamp)
    }
    return $payloadPath
}

function New-TestTrashJournal {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$LaneId,
        [string]$OperationId = [Guid]::NewGuid().ToString("N"),
        [hashtable]$Overrides = @{}
    )

    $rootMarker = Get-Content -LiteralPath (Join-Path $Root ".osg-development-cache.json") -Raw |
        ConvertFrom-Json
    $trashLeaf = "{0}--20260826T120000000Z--{1}" -f $LaneId, $OperationId
    $value = [ordered]@{
        schemaVersion = 1
        owner = "oneclick-subtitles-generator"
        rootId = [string]$rootMarker.rootId
        kind = "lane-delete"
        operationId = $OperationId
        laneId = $LaneId
        trashLeaf = $trashLeaf
    }
    foreach ($entry in $Overrides.GetEnumerator()) {
        $value[$entry.Key] = $entry.Value
    }
    $journalPath = Join-Path $Root ".trash\.osg-delete-$OperationId.json"
    [IO.File]::WriteAllText(
        $journalPath,
        (($value | ConvertTo-Json -Compress) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    return [pscustomobject]@{
        OperationId = $OperationId
        JournalPath = $journalPath
        TrashLeaf = $trashLeaf
        TrashPath = Join-Path $Root ".trash\$trashLeaf"
    }
}

function Invoke-Prune {
    param(
        [Parameter(Mandatory)][string]$Root,
        [long]$Limit = 1MB,
        [int]$InactiveDays = 14,
        [string]$ProtectLane = "none",
        [string]$ProtectUnit = "none",
        [switch]$Apply
    )

    $parameters = @{
        Action = "Prune"
        CacheRoot = $Root
        MaxBytes = $Limit
        InactiveDays = $InactiveDays
        ProtectLane = $ProtectLane
        ProtectUnit = $ProtectUnit
    }
    if ($Apply) { $parameters.Apply = $true }
    return Invoke-CacheManager $parameters
}

New-Item -ItemType Directory -Path $suiteRoot | Out-Null
try {
    Invoke-Test "initializes an owned cache and returns every named path" {
        $root = New-TestCacheRoot "layout"
        foreach ($lane in @("dev", "e2e", "package", "runtime", "evidence", "staging")) {
            $path = Get-ManagedPath -Root $root -Lane $lane
            Assert-True (Test-Path -LiteralPath $path -PathType Container) "Lane path was not created: $lane"
            Assert-True ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) "Lane escaped the cache root: $path"
        }
        $owner = Get-Content -LiteralPath (Join-Path $root ".osg-development-cache.json") -Raw | ConvertFrom-Json
        Assert-True ($owner.owner -eq "oneclick-subtitles-generator") "Root ownership marker has the wrong owner."
        Assert-True ($owner.rootId -match "^[0-9a-f]{32}$") "Root ownership marker has no stable root id."
    }

    Invoke-Test "machine path contract and process-held group lease cover every e2e publication lane" {
        $root = New-TestCacheRoot "path-contract"
        $pathResult = Invoke-CacheManager @{
            Action = "Path"
            Lane = "e2e"
            CacheRoot = $root
            OutputFormat = "Json"
        }
        Assert-Succeeds $pathResult "Machine-readable path contract failed."
        $contract = $pathResult.Output | ConvertFrom-Json
        foreach ($property in @(
            "cacheRoot", "cargoTargetDir", "frontendCacheRoot", "appPublicationRoot",
            "assetCacheRoot"
        )) {
            Assert-True ([IO.Path]::IsPathFullyQualified([string]$contract.$property)) "Path contract field is not absolute: $property"
            Assert-True ([string]$contract.$property -like "$root*") "Path contract field escaped the cache root: $property"
        }
        Assert-True ($contract.leasePaths.Count -eq 4) "E2E group must lease Cargo, frontend, app publication, and assets together."

        $acquire = Invoke-CacheManager @{
            Action = "Lease"
            LeaseOperation = "Acquire"
            LeaseProcessId = $PID
            Lane = "e2e"
            CacheRoot = $root
        }
        Assert-Succeeds $acquire "Could not acquire process-held e2e lease."
        $lease = $acquire.Output | ConvertFrom-Json
        Assert-True ($lease.leaseId -match "^[0-9a-f]{32}$") "Lease acquisition returned no exact token."
        foreach ($leasePath in $lease.leasePaths) {
            Assert-True (Test-Path -LiteralPath $leasePath -PathType Leaf) "Group lease file is missing: $leasePath"
        }

        $wrongRelease = Invoke-CacheManager @{
            Action = "Lease"
            LeaseOperation = "Release"
            LeaseId = ("f" * 32)
            Lane = "e2e"
            CacheRoot = $root
        }
        Assert-FailsWith $wrongRelease "does not own" "A wrong lease token released the build lease."
        foreach ($leasePath in $lease.leasePaths) {
            Assert-True (Test-Path -LiteralPath $leasePath -PathType Leaf) "Wrong token partially released a group lease."
        }

        $release = Invoke-CacheManager @{
            Action = "Lease"
            LeaseOperation = "Release"
            LeaseId = $lease.leaseId
            Lane = "e2e"
            CacheRoot = $root
        }
        Assert-Succeeds $release "Could not release process-held e2e lease."
        foreach ($leasePath in $lease.leasePaths) {
            Assert-False (Test-Path -LiteralPath $leasePath) "Released group lease file remains: $leasePath"
        }
    }

    Invoke-Test "a live-owner lease survives Prune and blocks a second acquire" {
        # Regression: ConvertFrom-Json auto-converts the marker's ISO-8601 creation field into a
        # [DateTime]; stringifying it lossily made every live lease compare as "process id was
        # reused", so Prune deleted active leases and Acquire could steal a leased group.
        $root = New-TestCacheRoot "live-lease"
        $acquire = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "e2e"; CacheRoot = $root
        }
        Assert-Succeeds $acquire "Could not acquire the live-owner lease."
        $lease = $acquire.Output | ConvertFrom-Json

        $prune = Invoke-Prune -Root $root -Apply
        Assert-Succeeds $prune "Prune failed against a live-owner lease."
        foreach ($leasePath in $lease.leasePaths) {
            Assert-True (Test-Path -LiteralPath $leasePath -PathType Leaf) "Prune reclaimed a lease whose owner process is alive: $leasePath"
        }

        $second = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "e2e"; CacheRoot = $root
        }
        Assert-FailsWith $second "already leased by a live process" "A second acquire stole a live-owner lease."
        foreach ($leasePath in $lease.leasePaths) {
            Assert-True (Test-Path -LiteralPath $leasePath -PathType Leaf) "A refused acquire removed the live lease: $leasePath"
        }

        $release = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Release"; LeaseId = $lease.leaseId
            Lane = "e2e"; CacheRoot = $root
        }
        Assert-Succeeds $release "Could not release the live-owner lease."
    }

    Invoke-Test "root-scoped file lock excludes an independent manager process" {
        $root = New-TestCacheRoot "root-lock"
        $lockPath = Join-Path $root ".osg-cache-manager.lock"
        $signalPath = Join-Path $suiteRoot "root-lock-ready.txt"
        $escapedLock = $lockPath.Replace("'", "''")
        $escapedSignal = $signalPath.Replace("'", "''")
        $helper = @"
`$stream = [IO.FileStream]::new(
    '$escapedLock', [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
try {
    [IO.File]::WriteAllText('$escapedSignal', 'ready')
    Start-Sleep -Seconds 30
}
finally { `$stream.Dispose() }
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
        $process = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
            "-NoProfile", "-NonInteractive", "-EncodedCommand", $encoded
        ) -WindowStyle Hidden -PassThru
        try {
            for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path -LiteralPath $signalPath); $attempt++) {
                Start-Sleep -Milliseconds 100
            }
            Assert-True (Test-Path -LiteralPath $signalPath -PathType Leaf) "Independent lock holder did not start."
            # A short deadline keeps the exclusion observable; the default deadline exists so
            # concurrent disjoint lane groups wait out each other's brief manager operations.
            $blocked = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root; LockWaitSeconds = 1 }
            Assert-FailsWith $blocked "root-scoped lock" "A second process entered the same managed cache root."
        }
        finally {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            [void]$process.WaitForExit(5000)
        }
        $after = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-Succeeds $after "Kernel cleanup did not release the root-scoped lock after process exit."
    }

    Invoke-Test "lease acquisition reclaims an exact owned lease after its PID exits" {
        $root = New-TestCacheRoot "stale-pid"
        $owner = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
            "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"
        ) -WindowStyle Hidden -PassThru
        try {
            $firstResult = Invoke-CacheManager @{
                Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $owner.Id
                Lane = "e2e"; CacheRoot = $root
            }
            Assert-Succeeds $firstResult "Could not create lease for the short-lived owner."
            $first = $firstResult.Output | ConvertFrom-Json
        }
        finally {
            Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
            [void]$owner.WaitForExit(5000)
        }
        $secondResult = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "e2e"; CacheRoot = $root
        }
        Assert-Succeeds $secondResult "A dead-PID lease was not reclaimed."
        $second = $secondResult.Output | ConvertFrom-Json
        Assert-True ($second.leaseId -ne $first.leaseId) "Stale lease token was reused."
        foreach ($leasePath in $second.leasePaths) {
            $marker = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
            Assert-True ($marker.processId -eq $PID) "Reclaimed lease did not bind to the new owner PID."
            Assert-True ($marker.leaseId -eq $second.leaseId) "Reclaimed group has mixed lease tokens."
        }
        $release = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Release"; LeaseId = $second.leaseId
            Lane = "e2e"; CacheRoot = $root
        }
        Assert-Succeeds $release "Could not release reclaimed dead-PID lease."
    }

    Invoke-Test "PID creation mismatch is reclaimed while corrupt lease data fails closed" {
        $root = New-TestCacheRoot "pid-reuse"
        $firstResult = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "package"; CacheRoot = $root
        }
        Assert-Succeeds $firstResult "Could not acquire fixture lease for PID-reuse test."
        $first = $firstResult.Output | ConvertFrom-Json
        foreach ($leasePath in $first.leasePaths) {
            $marker = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
            $marker.processCreatedUtc = ([DateTime]::Parse($marker.processCreatedUtc).ToUniversalTime().AddSeconds(1).ToString("O"))
            [IO.File]::WriteAllText(
                $leasePath,
                (($marker | ConvertTo-Json -Compress) + [Environment]::NewLine),
                [Text.UTF8Encoding]::new($false)
            )
        }
        $secondResult = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "package"; CacheRoot = $root
        }
        Assert-Succeeds $secondResult "PID-reuse-shaped stale lease was not reclaimed."
        $second = $secondResult.Output | ConvertFrom-Json
        Assert-True ($second.leaseId -ne $first.leaseId) "PID-reuse reclamation kept the stale token."
        $release = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Release"; LeaseId = $second.leaseId
            Lane = "package"; CacheRoot = $root
        }
        Assert-Succeeds $release "Could not release PID-reuse replacement lease."

        $pruneLeaseResult = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "runtime"; CacheRoot = $root
        }
        Assert-Succeeds $pruneLeaseResult "Could not acquire stale-prune fixture lease."
        $pruneLease = $pruneLeaseResult.Output | ConvertFrom-Json
        $pruneMarker = Get-Content -LiteralPath $pruneLease.leasePaths[0] -Raw | ConvertFrom-Json
        $pruneMarker.processId = [int]::MaxValue
        [IO.File]::WriteAllText(
            $pruneLease.leasePaths[0],
            (($pruneMarker | ConvertTo-Json -Compress) + [Environment]::NewLine),
            [Text.UTF8Encoding]::new($false)
        )
        $pruneResult = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 365 -Apply
        Assert-Succeeds $pruneResult "Prune did not reclaim a dead-PID exact owned lease."
        Assert-False (Test-Path -LiteralPath $pruneLease.leasePaths[0]) "Prune left a proven-stale exact owned lease behind."

        $corruptRoot = New-TestCacheRoot "corrupt-lease"
        $corruptPath = Join-Path (Get-ManagedPath -Root $corruptRoot -Lane "dev") ".osg-cache-lease"
        [IO.File]::WriteAllText($corruptPath, "not-json", [Text.UTF8Encoding]::new($false))
        $corruptAcquire = Invoke-CacheManager @{
            Action = "Lease"; LeaseOperation = "Acquire"; LeaseProcessId = $PID
            Lane = "dev"; CacheRoot = $corruptRoot
        }
        Assert-FailsWith $corruptAcquire "corrupt or foreign lease" "Corrupt lease was replaced."
        Assert-True (Test-Path -LiteralPath $corruptPath -PathType Leaf) "Corrupt lease was deleted instead of failing closed."
    }

    Invoke-Test "prunes whole lanes oldest-first to satisfy the cap" {
        $root = New-TestCacheRoot "cap"
        $old = Add-Payload -Root $root -Lane "dev" -Name "old" -Bytes 8192 -AgeDays 2
        $new = Add-Payload -Root $root -Lane "e2e" -Name "new" -Bytes 8192 -AgeDays 1
        $result = Invoke-Prune -Root $root -Limit 13000 -InactiveDays 365 -Apply
        Assert-Succeeds $result "Cap pruning failed."
        Assert-False (Test-Path -LiteralPath $old) "Oldest lane payload survived cap pruning."
        Assert-True (Test-Path -LiteralPath $new -PathType Leaf) "Newer lane was removed before the oldest lane."
        Assert-True (Test-Path -LiteralPath (Join-Path $root "cargo\dev\.osg-cache-entry.json")) "Pruned lane was not recreated as an owned empty lane."
    }

    Invoke-Test "age pruning removes only inactive whole lanes" {
        $root = New-TestCacheRoot "age"
        $old = Add-Payload -Root $root -Lane "evidence" -Name "old-run" -Bytes 1024 -AgeDays 30
        $new = Add-Payload -Root $root -Lane "staging" -Name "new-run" -Bytes 1024 -AgeDays 2
        $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14 -Apply
        Assert-Succeeds $result "Age pruning failed."
        Assert-False (Test-Path -LiteralPath $old) "Inactive evidence lane was not removed."
        Assert-True (Test-Path -LiteralPath $new) "Active staging lane was removed by age pruning."
    }

    Invoke-Test "prune is a non-mutating dry run without Apply" {
        $root = New-TestCacheRoot "dry-run"
        $payload = Add-Payload -Root $root -Lane "package" -Name "old" -Bytes 4096 -AgeDays 40
        $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14
        Assert-Succeeds $result "Dry-run pruning failed."
        Assert-Contains $result.Output "WOULD REMOVE" "Dry run did not report its planned removal."
        Assert-True (Test-Path -LiteralPath $payload) "Dry run mutated a lane."
        $trashChildren = @(Get-ChildItem -LiteralPath (Join-Path $root ".trash") -Force | Where-Object Name -ne ".osg-cache-area.json")
        Assert-True ($trashChildren.Count -eq 0) "Dry run staged bytes in trash."
    }

    Invoke-Test "lease file protects a lane from age and cap pruning" {
        $root = New-TestCacheRoot "lease"
        $payload = Add-Payload -Root $root -Lane "dev" -Name "leased" -Bytes 8192 -AgeDays 40
        $lane = Get-ManagedPath -Root $root -Lane "dev"
        [IO.File]::WriteAllText((Join-Path $lane ".osg-cache-lease"), "lease", [Text.UTF8Encoding]::new($false))
        $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14 -Apply
        Assert-Succeeds $result "Lease-protected prune failed."
        Assert-True (Test-Path -LiteralPath $payload) "Lease-protected lane was removed."
    }

    Invoke-Test "a process command line using a lane protects that lane" {
        $root = New-TestCacheRoot "process"
        $payload = Add-Payload -Root $root -Lane "e2e" -Name "active" -Bytes 4096 -AgeDays 40
        $lane = Get-ManagedPath -Root $root -Lane "e2e"
        $reportedLane = "\\?\$lane"
        $escapedLane = $reportedLane.Replace("'", "''")
        $process = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "`$activeLane = '$escapedLane'; Start-Sleep -Seconds 30"
        ) -WindowStyle Hidden -PassThru
        try {
            $seen = $false
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                $record = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
                if ([string]$record.CommandLine -like "*$reportedLane*") {
                    $seen = $true
                    break
                }
                Start-Sleep -Milliseconds 100
            }
            Assert-True $seen "Test helper process did not expose the verbatim lane identity in its command line."
            $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14 -Apply
            Assert-Succeeds $result "Process-protected prune failed."
            Assert-True (Test-Path -LiteralPath $payload) "In-use lane was removed."
        }
        finally {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            [void]$process.WaitForExit(5000)
        }
    }

    Invoke-Test "a bare UNC root token does not protect unrelated managed lanes" {
        $root = New-TestCacheRoot "bare-unc-token"
        $payload = Add-Payload -Root $root -Lane "dev" -Name "inactive" -Bytes 4096 -AgeDays 40
        $helperPath = Join-Path $suiteRoot "bare-unc-helper.ps1"
        [IO.File]::WriteAllText(
            $helperPath,
            "param([string]`$Token)`nStart-Sleep -Seconds 30`n",
            [Text.UTF8Encoding]::new($false)
        )
        $process = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @(
            "-NoProfile", "-NonInteractive", "-File", $helperPath, "\\"
        ) -WindowStyle Hidden -PassThru
        try {
            Start-Sleep -Milliseconds 300
            $record = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
            Assert-Contains ([string]$record.CommandLine) "\\" "Helper process did not expose its bare UNC token."
            # This assertion is about parsing one bare UNC token. An unrelated live process with an
            # ambiguous path must not turn the unit test into a workstation-wide CIM integration
            # test; that fail-closed behavior has its own case immediately below.
            function global:Get-CimInstance { return @($record) }
            try {
                $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14 -Apply
            }
            finally {
                Remove-Item Function:\Get-CimInstance -Force
            }
            Assert-Succeeds $result "Bare UNC root token made process inspection ambiguous."
            Assert-False (Test-Path -LiteralPath $payload) "Bare UNC root token protected an unrelated lane.`n$($result.Output)"
        }
        finally {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            [void]$process.WaitForExit(5000)
        }
    }

    Invoke-Test "CIM failure protects all lanes and returns nonzero when the cap cannot be met" {
        $root = New-TestCacheRoot "cim-failure"
        $payload = Add-Payload -Root $root -Lane "dev" -Name "active" -Bytes 8192 -AgeDays 40
        function global:Get-CimInstance { throw "synthetic CIM outage" }
        try {
            $result = Invoke-Prune -Root $root -Limit 1024 -InactiveDays 14 -Apply
        }
        finally {
            Remove-Item Function:\Get-CimInstance -Force
        }
        Assert-FailsWith $result "Protected, leased, or in-use cache bytes alone exceed" "CIM failure did not fail closed."
        Assert-True (Test-Path -LiteralPath $payload) "CIM failure allowed lane deletion."
    }

    Invoke-Test "explicitly protected bytes above the cap return nonzero without mutation" {
        $root = New-TestCacheRoot "protected-cap"
        $payload = Add-Payload -Root $root -Lane "package" -Name "protected" -Bytes 8192 -AgeDays 40
        $result = Invoke-Prune -Root $root -Limit 1024 -InactiveDays 14 -ProtectLane "package" -Apply
        Assert-FailsWith $result "Protected, leased, or in-use cache bytes alone exceed" "Protected bytes above cap did not return an error."
        Assert-True (Test-Path -LiteralPath $payload) "Explicitly protected lane was mutated."
    }

    Invoke-Test "exact app protection keeps only the live publication while e2e peers and old trash prune" {
        $root = New-TestCacheRoot "protect-app-unit"
        $contractResult = Invoke-CacheManager @{
            Action = "Path"; Lane = "e2e"; CacheRoot = $root; OutputFormat = "Json"
        }
        Assert-Succeeds $contractResult "Could not resolve the e2e path contract for exact protection."
        $contract = $contractResult.Output | ConvertFrom-Json
        $oldTime = [DateTime]::UtcNow.AddDays(-40)
        foreach ($path in @($contract.cargoTargetDir, $contract.frontendCacheRoot, $contract.assetCacheRoot)) {
            $payload = Join-Path $path "old.bin"
            [IO.File]::WriteAllBytes($payload, [byte[]]::new(2048))
            [IO.File]::SetLastWriteTimeUtc($payload, $oldTime)
        }

        $oldApp = Join-Path $contract.appPublicationRoot "failed-delete.bin"
        [IO.File]::WriteAllBytes($oldApp, [byte[]]::new(2048))
        [IO.File]::SetLastWriteTimeUtc($oldApp, $oldTime)
        $trashPath = Join-Path $root (".trash\apps-e2e--20260826T120000000Z--{0}" -f [Guid]::NewGuid().ToString("N"))
        [IO.Directory]::Move($contract.appPublicationRoot, $trashPath)

        $recreate = Invoke-CacheManager @{ Action = "Path"; Lane = "e2e"; CacheRoot = $root }
        Assert-Succeeds $recreate "Could not recreate the live app publication after partial trash."
        $lastKnownGood = Join-Path $contract.appPublicationRoot "last-known-good.exe"
        [IO.File]::WriteAllBytes($lastKnownGood, [byte[]]::new(2048))
        [IO.File]::SetLastWriteTimeUtc($lastKnownGood, $oldTime)

        $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14 -ProtectUnit "apps-e2e" -Apply
        Assert-Succeeds $result "Exact app-unit protection prune failed."
        Assert-True (Test-Path -LiteralPath $lastKnownGood -PathType Leaf) "The current app publication was pruned."
        Assert-False (Test-Path -LiteralPath $trashPath) "Old apps-e2e trash inherited live-unit protection."
        foreach ($path in @($contract.cargoTargetDir, $contract.frontendCacheRoot, $contract.assetCacheRoot)) {
            Assert-False (Test-Path -LiteralPath (Join-Path $path "old.bin")) "A non-app e2e unit was over-protected: $path"
        }
    }

    Invoke-Test "unknown root and cargo bytes fail closed" {
        $root = New-TestCacheRoot "unknown-root"
        [IO.File]::WriteAllText((Join-Path $root "rogue.bin"), "not managed")
        $result = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $result "Unmanaged cache bytes" "Unknown root bytes were accepted."

        $root2 = New-TestCacheRoot "unknown-cargo"
        New-Item -ItemType Directory -Path (Join-Path $root2 "cargo\mystery") | Out-Null
        $result2 = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root2 }
        Assert-FailsWith $result2 "Unmanaged cache bytes" "Unknown Cargo lane was accepted."
    }

    Invoke-Test "invalid runtime content address and bounded loose files fail closed" {
        $root = New-TestCacheRoot "unknown-runtime"
        New-Item -ItemType Directory -Path (Join-Path $root "runtime\sha256\not-a-sha") | Out-Null
        $result = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $result "lowercase SHA-256" "Invalid runtime cache entry was accepted."

        $root2 = New-TestCacheRoot "unknown-evidence"
        [IO.File]::WriteAllText((Join-Path $root2 "evidence\loose.bin"), "not a bounded run")
        $result2 = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root2 }
        Assert-FailsWith $result2 "Unmanaged cache bytes" "Loose evidence bytes were accepted."

        $root3 = New-TestCacheRoot "evidence-index"
        [IO.File]::WriteAllText((Join-Path $root3 "evidence\README.md"), "# Real workflow screenshots")
        $result3 = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root3 }
        Assert-Succeeds $result3 "The evidence publisher's cross-workflow README index was rejected."
        [IO.File]::WriteAllText((Join-Path $root3 "staging\README.md"), "not an owned index")
        $result4 = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root3 }
        Assert-FailsWith $result4 "Unmanaged cache bytes" "A loose staging README was accepted."
    }

    Invoke-Test "traversal, repository, and filesystem roots are rejected before creation" {
        $base = Join-Path $suiteRoot "traversal"
        $traversal = Join-Path $base "safe\..\escaped"
        $result = Invoke-CacheManager @{ Action = "Path"; CacheRoot = $traversal; Lane = "dev" }
        Assert-FailsWith $result "traversal segments" "Traversal path was accepted."
        Assert-False (Test-Path -LiteralPath (Join-Path $base "escaped")) "Traversal target was created."

        $repoResult = Invoke-CacheManager @{ Action = "Path"; CacheRoot = (Join-Path $PSScriptRoot "inside-repo"); Lane = "dev" }
        Assert-FailsWith $repoResult "outside" "Repository child path was accepted."

        $namespaceTarget = Join-Path $suiteRoot "namespace-cache"
        foreach ($spelling in @(
            "\\?\$namespaceTarget",
            "\\.\$namespaceTarget",
            "\??\$namespaceTarget",
            "\\??\$namespaceTarget"
        )) {
            $namespaceResult = Invoke-CacheManager @{ Action = "Path"; CacheRoot = $spelling; Lane = "dev" }
            Assert-FailsWith $namespaceResult "namespace spelling" "A caller-controlled Windows namespace spelling was accepted: $spelling"
        }
        Assert-False (Test-Path -LiteralPath $namespaceTarget) "Rejected namespace spelling mutated its target."

        $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
        $repoNamespace = "\\?\$(Join-Path $repoRoot 'inside-verbatim')"
        $repoNamespaceResult = Invoke-CacheManager @{ Action = "Path"; CacheRoot = $repoNamespace; Lane = "dev" }
        Assert-FailsWith $repoNamespaceResult "namespace spelling" "A verbatim repository-child alias was accepted."

        $shortRepo = ((& cmd.exe /d /c "for %I in (`"$repoRoot`") do @echo %~sI") | Out-String).Trim()
        if (-not [string]::IsNullOrWhiteSpace($shortRepo) -and
            -not $shortRepo.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $shortRepo -PathType Container)) {
            $shortResult = Invoke-CacheManager @{
                Action = "Path"; CacheRoot = (Join-Path $shortRepo "inside-short-alias"); Lane = "dev"
            }
            Assert-FailsWith $shortResult "outside" "An 8.3 repository-child alias bypassed overlap protection."
        }

        $substDrive = @('Z', 'Y', 'X', 'W', 'V', 'U', 'T') | Where-Object {
            -not (Test-Path -LiteralPath "${_}:\") -and $null -eq (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue)
        } | Select-Object -First 1
        if ($null -ne $substDrive -and $null -ne (Get-Command subst.exe -ErrorAction SilentlyContinue)) {
            & subst.exe "${substDrive}:" $repoRoot
            if ($LASTEXITCODE -eq 0) {
                try {
                    $substResult = Invoke-CacheManager @{
                        Action = "Path"; CacheRoot = "${substDrive}:\inside-subst-alias"; Lane = "dev"
                    }
                    Assert-FailsWith $substResult "outside" "A SUBST repository-child alias bypassed overlap protection."
                }
                finally {
                    & subst.exe "${substDrive}:" /D
                }
            }
        }

        $trailingDot = Invoke-CacheManager @{ Action = "Path"; CacheRoot = "$namespaceTarget."; Lane = "dev" }
        Assert-FailsWith $trailingDot "trailing-dot" "A trailing-dot cache identity was accepted."
        $trailingSpace = Invoke-CacheManager @{ Action = "Path"; CacheRoot = "$namespaceTarget "; Lane = "dev" }
        Assert-FailsWith $trailingSpace "trailing-space" "A trailing-space cache identity was accepted."
        $driveRoot = [IO.Path]::GetPathRoot($suiteRoot)
        $rootResult = Invoke-CacheManager @{ Action = "Path"; CacheRoot = $driveRoot; Lane = "dev" }
        Assert-FailsWith $rootResult "filesystem or share root" "Filesystem root was accepted."
    }

    Invoke-Test "reparse points in ancestors and managed payloads fail closed" {
        $target = Join-Path $suiteRoot "junction-target"
        New-Item -ItemType Directory -Path $target | Out-Null
        $ancestorLink = Join-Path $suiteRoot "junction-parent"
        New-Item -ItemType Junction -Path $ancestorLink -Target $target | Out-Null
        $script:junctions.Add($ancestorLink)
        $ancestorResult = Invoke-CacheManager @{ Action = "Path"; CacheRoot = (Join-Path $ancestorLink "cache"); Lane = "dev" }
        Assert-FailsWith $ancestorResult "reparse point" "Reparse-point ancestor was accepted."

        $root = New-TestCacheRoot "reparse-payload"
        $external = Join-Path $suiteRoot "payload-target"
        New-Item -ItemType Directory -Path $external | Out-Null
        $payloadLink = Join-Path $root "evidence\linked-run"
        New-Item -ItemType Junction -Path $payloadLink -Target $external | Out-Null
        $script:junctions.Add($payloadLink)
        $payloadResult = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $payloadResult "reparse point" "Reparse point inside managed payload was accepted."

        Remove-Item -LiteralPath $payloadLink -Force
        $nestedRun = Join-Path $root "evidence\nested-run"
        New-Item -ItemType Directory -Path $nestedRun | Out-Null
        $nestedLink = Join-Path $nestedRun "redirect"
        New-Item -ItemType Junction -Path $nestedLink -Target $external | Out-Null
        $script:junctions.Add($nestedLink)
        $fastPathResult = Invoke-CacheManager @{ Action = "Path"; CacheRoot = $root; Lane = "e2e" }
        Assert-Succeeds $fastPathResult "Path contract recursively walked managed payload bytes."
        $nestedStatus = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $nestedStatus "reparse point" "Status did not fail closed on a nested payload reparse point."

        # A live scenario junctions persistent asset caches into its leased staging run root by
        # design; measurement must skip the link without following it or wedging every command.
        Remove-Item -LiteralPath $nestedLink -Force
        $stagingRun = Join-Path $root "staging\osg-e2e-run-live"
        New-Item -ItemType Directory -Path (Join-Path $stagingRun "data") -Force | Out-Null
        $stagingLink = Join-Path $stagingRun "data\native-tools"
        New-Item -ItemType Junction -Path $stagingLink -Target $external | Out-Null
        $script:junctions.Add($stagingLink)
        $stagingStatus = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-Succeeds $stagingStatus "A run root's designed junction wedged every managed command."
    }

    Invoke-Test "partial owned trash is recovered and its live lane is recreated" {
        $root = New-TestCacheRoot "trash-recovery"
        $payload = Add-Payload -Root $root -Lane "dev" -Name "orphan" -Bytes 2048 -AgeDays 1
        $lane = Get-ManagedPath -Root $root -Lane "dev"
        $trashRoot = Join-Path $root ".trash"
        $trashPath = Join-Path $trashRoot ("cargo-dev--20260826T120000000Z--{0}" -f [Guid]::NewGuid().ToString("N"))
        [IO.Directory]::Move($lane, $trashPath)
        Assert-True (Test-Path -LiteralPath (Join-Path $trashPath (Split-Path -Leaf $payload))) "Simulated partial trash did not contain the payload."
        $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 365 -Apply
        Assert-Succeeds $result "Partial trash recovery failed."
        Assert-False (Test-Path -LiteralPath $trashPath) "Recovered trash entry still exists.`n$($result.Output)"
        Assert-True (Test-Path -LiteralPath (Join-Path $lane ".osg-cache-entry.json")) "Live lane was not recreated after recovery."
    }

    Invoke-Test "a parent journal authorizes partial recursive-delete residue without its lane marker" {
        $root = New-TestCacheRoot "journal-partial-delete"
        $payload = Add-Payload -Root $root -Lane "dev" -Name "survivor" -Bytes 2048 -AgeDays 1
        $lane = Get-ManagedPath -Root $root -Lane "dev"
        $nested = Join-Path $lane "nested"
        New-Item -ItemType Directory -Path $nested | Out-Null
        $alreadyDeleted = Join-Path $nested "already-deleted.bin"
        $residue = Join-Path $nested "residue.bin"
        [IO.File]::WriteAllBytes($alreadyDeleted, [byte[]]::new(128))
        [IO.File]::WriteAllBytes($residue, [byte[]]::new(128))

        $journal = New-TestTrashJournal -Root $root -LaneId "cargo-dev"
        [IO.Directory]::Move($lane, $journal.TrashPath)
        [IO.File]::Delete((Join-Path $journal.TrashPath ".osg-cache-entry.json"))
        [IO.File]::Delete((Join-Path $journal.TrashPath "nested\already-deleted.bin"))
        Assert-True (Test-Path -LiteralPath (Join-Path $journal.TrashPath (Split-Path -Leaf $payload))) "The simulated recursive-delete residue lost its surviving payload."
        Assert-True (Test-Path -LiteralPath (Join-Path $journal.TrashPath "nested\residue.bin")) "The simulated nested residue was not created."

        $result = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 365 -Apply
        Assert-Succeeds $result "Journal-authorized recursive-delete recovery failed."
        Assert-False (Test-Path -LiteralPath $journal.TrashPath) "Journal-authorized residue survived recovery.`n$($result.Output)"
        Assert-False (Test-Path -LiteralPath $journal.JournalPath) "Completed recovery left its authorization journal behind."
        Assert-True (Test-Path -LiteralPath (Join-Path $lane ".osg-cache-entry.json")) "Recovery did not recreate the live owned lane."
    }

    Invoke-Test "atomic marker residue is dry-run safe, recovered, and lookalikes fail closed" {
        $root = New-TestCacheRoot "atomic-marker-residue"
        $lane = Get-ManagedPath -Root $root -Lane "dev"
        $leaseHex = [Convert]::ToHexString(
            [Text.Encoding]::UTF8.GetBytes(".osg-cache-lease")
        ).ToLowerInvariant()
        $residue = Join-Path $lane (
            ".osg-write-{0}-{1}.tmp" -f $leaseHex, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($residue, '{"partial":', [Text.UTF8Encoding]::new($false))

        $dryRun = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 365
        Assert-Succeeds $dryRun "Dry-run inspection rejected exact atomic marker residue."
        Assert-True (Test-Path -LiteralPath $residue -PathType Leaf) "Dry run removed atomic marker residue."

        $recovery = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-Succeeds $recovery "Owned atomic marker residue did not recover."
        Assert-False (Test-Path -LiteralPath $residue) "Recovered atomic marker residue remains."

        $lookalike = Join-Path $lane (
            ".OSG-WRITE-{0}-{1}.tmp" -f $leaseHex, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($lookalike, 'foreign', [Text.UTF8Encoding]::new($false))
        $rejected = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $rejected "Unrecognized atomic-write residue" "Case-variant atomic residue was accepted."
        Assert-True (Test-Path -LiteralPath $lookalike -PathType Leaf) "Foreign marker lookalike was mutated."
    }

    Invoke-Test "atomic-looking bytes never authorize adoption of an unowned boundary" {
        $root = Join-Path $suiteRoot "atomic-unowned-root\cache"
        New-Item -ItemType Directory -Path $root | Out-Null
        $rootMarkerHex = [Convert]::ToHexString(
            [Text.Encoding]::UTF8.GetBytes(".osg-development-cache.json")
        ).ToLowerInvariant()
        $rootResidue = Join-Path $root (
            ".osg-write-{0}-{1}.tmp" -f $rootMarkerHex, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($rootResidue, '{"partial":', [Text.UTF8Encoding]::new($false))
        $rootResult = Invoke-CacheManager @{ Action = "Path"; Lane = "dev"; CacheRoot = $root }
        Assert-FailsWith $rootResult "before ownership is verified" "Atomic-looking root bytes authorized adoption."
        Assert-True (Test-Path -LiteralPath $rootResidue -PathType Leaf) "Unowned root residue was deleted."
        Assert-False (Test-Path -LiteralPath (Join-Path $root ".osg-development-cache.json")) "Unowned root was adopted."

        $ownedRoot = New-TestCacheRoot "atomic-unowned-children"
        $area = Join-Path $ownedRoot "frontend"
        Remove-Item -LiteralPath $area -Recurse -Force
        New-Item -ItemType Directory -Path $area | Out-Null
        $areaMarkerHex = [Convert]::ToHexString(
            [Text.Encoding]::UTF8.GetBytes(".osg-cache-area.json")
        ).ToLowerInvariant()
        $areaResidue = Join-Path $area (
            ".osg-write-{0}-{1}.tmp" -f $areaMarkerHex, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($areaResidue, '{"partial":', [Text.UTF8Encoding]::new($false))
        $areaResult = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $ownedRoot }
        Assert-FailsWith $areaResult "before ownership is verified" "Atomic-looking area bytes authorized adoption."
        Assert-True (Test-Path -LiteralPath $areaResidue -PathType Leaf) "Unowned area residue was deleted."
        Assert-False (Test-Path -LiteralPath (Join-Path $area ".osg-cache-area.json")) "Unowned area was adopted."

        Remove-Item -LiteralPath $area -Recurse -Force
        $repair = Invoke-CacheManager @{ Action = "Path"; Lane = "dev"; CacheRoot = $ownedRoot }
        Assert-Succeeds $repair "Could not restore the isolated owned area after the hostile case."
        $lane = Join-Path $ownedRoot "cargo\dev"
        Remove-Item -LiteralPath (Join-Path $lane ".osg-cache-entry.json") -Force
        $entryMarkerHex = [Convert]::ToHexString(
            [Text.Encoding]::UTF8.GetBytes(".osg-cache-entry.json")
        ).ToLowerInvariant()
        $laneResidue = Join-Path $lane (
            ".osg-write-{0}-{1}.tmp" -f $entryMarkerHex, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($laneResidue, '{"partial":', [Text.UTF8Encoding]::new($false))
        $laneResult = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $ownedRoot }
        Assert-FailsWith $laneResult "before ownership is verified" "Atomic-looking lane bytes authorized adoption."
        Assert-True (Test-Path -LiteralPath $laneResidue -PathType Leaf) "Unowned lane residue was deleted."
        Assert-False (Test-Path -LiteralPath (Join-Path $lane ".osg-cache-entry.json")) "Unowned lane was adopted."
    }

    Invoke-Test "trash journal atomic residue is bounded without trusting partial JSON" {
        $root = New-TestCacheRoot "atomic-trash-journal"
        $trashRoot = Join-Path $root ".trash"
        $operationId = [Guid]::NewGuid().ToString("N")
        $residue = Join-Path $trashRoot (
            ".osg-delete-{0}.json.write-{1}.tmp" -f $operationId, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($residue, '{"partial":', [Text.UTF8Encoding]::new($false))

        $dryRun = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 365
        Assert-Succeeds $dryRun "Dry-run inspection rejected exact trash-journal residue."
        Assert-True (Test-Path -LiteralPath $residue -PathType Leaf) "Dry run removed trash-journal residue."

        $recovery = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-Succeeds $recovery "Trash-journal atomic residue did not recover."
        Assert-False (Test-Path -LiteralPath $residue) "Recovered trash-journal residue remains."

        $lookalike = Join-Path $trashRoot (
            ".osg-delete-{0}.json.write-{1}.TMP" -f $operationId, [Guid]::NewGuid().ToString("N")
        )
        [IO.File]::WriteAllText($lookalike, 'foreign', [Text.UTF8Encoding]::new($false))
        $rejected = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $rejected "Unrecognized bytes" "Trash-journal lookalike was accepted."
        Assert-True (Test-Path -LiteralPath $lookalike -PathType Leaf) "Foreign trash lookalike was mutated."
    }

    Invoke-Test "malformed and foreign trash journals fail closed" {
        $malformedRoot = New-TestCacheRoot "journal-malformed"
        $malformedId = [Guid]::NewGuid().ToString("N")
        $malformedPath = Join-Path $malformedRoot ".trash\.osg-delete-$malformedId.json"
        [IO.File]::WriteAllText($malformedPath, "{not-json", [Text.UTF8Encoding]::new($false))
        $malformed = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $malformedRoot }
        Assert-FailsWith $malformed "not valid JSON" "Malformed journal bytes were accepted."
        Assert-True (Test-Path -LiteralPath $malformedPath -PathType Leaf) "Malformed journal was mutated instead of refused."

        $foreignRoot = New-TestCacheRoot "journal-foreign"
        $foreign = New-TestTrashJournal -Root $foreignRoot -LaneId "cargo-dev" -Overrides @{
            owner = "another-project"
        }
        $foreignResult = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $foreignRoot }
        Assert-FailsWith $foreignResult "does not belong" "Foreign journal ownership was accepted."
        Assert-True (Test-Path -LiteralPath $foreign.JournalPath -PathType Leaf) "Foreign journal was mutated instead of refused."

        $caseRoot = New-TestCacheRoot "journal-foreign-case"
        $caseId = [Guid]::NewGuid().ToString("N")
        $casePath = Join-Path $caseRoot ".trash\.OSG-DELETE-$caseId.json"
        [IO.File]::WriteAllText($casePath, "foreign", [Text.UTF8Encoding]::new($false))
        $caseResult = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $caseRoot }
        Assert-FailsWith $caseResult "Unrecognized bytes" "Differently cased foreign journal name bypassed trash validation."
        Assert-True (Test-Path -LiteralPath $casePath -PathType Leaf) "Differently cased foreign journal was mutated instead of refused."
    }

    Invoke-Test "journal recovery is non-mutating without Apply and under WhatIf" {
        $root = New-TestCacheRoot "journal-dry-run"
        $payload = Add-Payload -Root $root -Lane "dev" -Name "dry-run-residue" -Bytes 1024 -AgeDays 30
        $lane = Get-ManagedPath -Root $root -Lane "dev"
        $journal = New-TestTrashJournal -Root $root -LaneId "cargo-dev"
        [IO.Directory]::Move($lane, $journal.TrashPath)
        [IO.File]::Delete((Join-Path $journal.TrashPath ".osg-cache-entry.json"))
        $residuePath = Join-Path $journal.TrashPath (Split-Path -Leaf $payload)
        $journalBefore = [IO.File]::ReadAllBytes($journal.JournalPath)
        $payloadBefore = [IO.File]::ReadAllBytes($residuePath)

        $dryRun = Invoke-Prune -Root $root -Limit 1MB -InactiveDays 14
        Assert-Succeeds $dryRun "Journal recovery dry run failed."
        Assert-Contains $dryRun.Output "WOULD RECOVER JOURNALED TRASH" "Dry run did not disclose journal recovery."
        Assert-True (Test-Path -LiteralPath $journal.JournalPath -PathType Leaf) "Dry run deleted the journal."
        Assert-True (Test-Path -LiteralPath $residuePath -PathType Leaf) "Dry run deleted recursive-delete residue."
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$journalBefore, [byte[]][IO.File]::ReadAllBytes($journal.JournalPath))) "Dry run rewrote the journal."
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$payloadBefore, [byte[]][IO.File]::ReadAllBytes($residuePath))) "Dry run rewrote residue bytes."

        $whatIf = Invoke-CacheManager @{
            Action = "Prune"
            CacheRoot = $root
            MaxBytes = 1MB
            InactiveDays = 14
            Apply = $true
            WhatIf = $true
        }
        Assert-Succeeds $whatIf "-Apply -WhatIf journal recovery failed."
        Assert-True (Test-Path -LiteralPath $journal.JournalPath -PathType Leaf) "-WhatIf deleted the journal despite ShouldProcess."
        Assert-True (Test-Path -LiteralPath $residuePath -PathType Leaf) "-WhatIf deleted recursive-delete residue."
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$journalBefore, [byte[]][IO.File]::ReadAllBytes($journal.JournalPath))) "-WhatIf rewrote the journal."
        Assert-True ([Linq.Enumerable]::SequenceEqual([byte[]]$payloadBefore, [byte[]][IO.File]::ReadAllBytes($residuePath))) "-WhatIf rewrote residue bytes."
    }

    Invoke-Test "unknown trash and leased partial trash both fail safe" {
        $root = New-TestCacheRoot "trash-guard"
        New-Item -ItemType Directory -Path (Join-Path $root ".trash\mystery") | Out-Null
        $unknown = Invoke-CacheManager @{ Action = "Status"; CacheRoot = $root }
        Assert-FailsWith $unknown "Unrecognized bytes" "Unknown trash was accepted."

        $root2 = New-TestCacheRoot "trash-lease"
        $payload = Add-Payload -Root $root2 -Lane "e2e" -Name "leased-trash" -Bytes 2048 -AgeDays 40
        $lane = Get-ManagedPath -Root $root2 -Lane "e2e"
        [IO.File]::WriteAllText((Join-Path $lane ".osg-cache-lease"), "lease")
        $trashPath = Join-Path $root2 (".trash\cargo-e2e--20260826T120000000Z--{0}" -f [Guid]::NewGuid().ToString("N"))
        [IO.Directory]::Move($lane, $trashPath)
        $result = Invoke-Prune -Root $root2 -Limit 1MB -InactiveDays 14 -Apply
        Assert-Succeeds $result "Leased partial-trash inspection failed."
        Assert-True (Test-Path -LiteralPath $trashPath) "Leased partial trash was deleted."
        Assert-True (Test-Path -LiteralPath (Join-Path $trashPath (Split-Path -Leaf $payload))) "Leased trash payload was lost."
    }
}
finally {
    foreach ($junction in $script:junctions) {
        if (Test-Path -LiteralPath $junction) {
            Remove-Item -LiteralPath $junction -Force
        }
    }
    $resolvedSuite = [IO.Path]::GetFullPath($suiteRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedSuite.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedSuite) -notmatch "^osg-dev-cache-tests-[0-9a-f]{32}$") {
        throw "Refusing unsafe test cleanup path: $resolvedSuite"
    }
    if (Test-Path -LiteralPath $resolvedSuite) {
        Remove-Item -LiteralPath $resolvedSuite -Recurse -Force
    }
}

Write-Host "$($script:passed) passed, $($script:failed) failed"
if ($script:failed -ne 0) {
    exit 1
}
