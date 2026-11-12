# Agent Files helper for sessions on this Windows computer. Reads only; opens nothing.
#   alive -Pids 1,2      prints the ids still running, one per line
#   codex                prints "<rollout file>`t<cwd>" for the 30 newest Codex sessions of the last 7 days
#   chunk -File -Offset -Max
#                        prints the file size, the next offset, then the UTF-8 text up to the last
#                        complete line in at most Max bytes from Offset
#   exists -Cwd <dir> <path>...
#                        one line per path: "d" or "f", a tab, the full path; an empty line when it
#                        is missing (devices and other non-files count as missing)
[CmdletBinding(PositionalBinding = $false)]
param([string]$Action, [string]$Pids, [string]$File, [long]$Offset = 0, [long]$Max = 4194304, [string]$Cwd,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$out = [Console]::Out

switch ($Action) {
  'alive' {
    $want = $Pids -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
    if ($want) { Get-Process -Id $want -ErrorAction SilentlyContinue | ForEach-Object { $out.WriteLine($_.Id) } }
  }
  'codex' {
    $root = Join-Path $HOME '.codex\sessions'
    if (Test-Path -LiteralPath $root) {
      $since = (Get-Date).AddDays(-7)
      Get-ChildItem -LiteralPath $root -Recurse -Filter 'rollout-*.jsonl' -File |
        Where-Object { $_.LastWriteTime -gt $since } | Sort-Object FullName -Descending | Select-Object -First 30 | ForEach-Object {
          $cwd = ''
          try {
            $s = New-Object System.IO.StreamReader($_.FullName)
            try { $line = $s.ReadLine() } finally { $s.Dispose() }
            if ($line -match '"cwd":"((?:[^"\\]|\\.)*)"') {
              $raw = $Matches[1]
              try { $cwd = ConvertFrom-Json ('"' + $raw + '"') } catch { $cwd = $raw -replace '\\\\', '\' }
            }
          } catch {}
          $out.WriteLine($_.FullName + "`t" + $cwd)
        }
    }
  }
  'chunk' {
    try { $fs = [IO.File]::Open($File, 'Open', 'Read', 'ReadWrite') } catch { exit 5 }
    try {
      $len = $fs.Length
      if ($Offset -ge $len) { $out.Write("$len`n$Offset`n"); break }
      $n = [Math]::Min($Max, $len - $Offset)
      $buf = New-Object byte[] $n
      [void]$fs.Seek($Offset, 'Begin')
      $read = 0
      while ($read -lt $n) { $r = $fs.Read($buf, $read, $n - $read); if ($r -le 0) { break }; $read += $r }
      $cut = [Array]::LastIndexOf($buf, [byte]10, $read - 1) + 1
      # A line longer than Max (a large base64 image) is skipped whole; its pieces fail JSON parsing.
      if ($cut -eq 0 -and $read -eq $Max) { $cut = $read }
      $text = [Text.Encoding]::UTF8.GetString($buf, 0, $cut)
      $out.Write("$len`n$($Offset + $cut)`n$text")
    } finally { $fs.Dispose() }
  }
  'exists' {
    foreach ($raw in $Rest) {
      $line = ''
      try {
        $p = $raw.Trim()
        if ($p.StartsWith('~')) { $p = $HOME + $p.Substring(1) }
        if ($p -notmatch '^([A-Za-z]:[\\/]|\\\\)') { if ($Cwd) { $p = Join-Path $Cwd $p } else { $p = $null } }
        if ($p) {
          # "file.cs:12:3" (a line reference) falls back to "file.cs".
          foreach ($c in @($p, ($p -replace '(?<=.):\d+(:\d+)?$', '')) | Select-Object -Unique) {
            try { $c = [IO.Path]::GetFullPath($c) } catch { continue }
            if (Test-Path -LiteralPath $c -PathType Container) { $line = "d`t$c"; break }
            if (Test-Path -LiteralPath $c -PathType Leaf) { $line = "f`t$c"; break }
          }
        }
      } catch {}
      $out.WriteLine($line)
    }
  }
  default { exit 2 }
}
