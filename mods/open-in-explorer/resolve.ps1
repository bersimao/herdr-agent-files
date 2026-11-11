# Resolves a path for Open in Explorer on a Windows terminal. Prints "d" or "f", then the full path.
# Exit codes: 4 = invalid path, 5 = path does not exist, 7 = relative path without a Cwd. Opens nothing.
param([string]$Path, [string]$Cwd)
try {
  $p = $Path.Trim().Trim('"', '`')
  if ($p.StartsWith('~')) { $p = $HOME + $p.Substring(1) }
  if ($p -notmatch '^([A-Za-z]:[\\/]|\\\\)') { if (-not $Cwd) { exit 7 }; $p = Join-Path $Cwd $p }
  $p = [IO.Path]::GetFullPath($p)
} catch { exit 4 }
if (Test-Path -LiteralPath $p -PathType Container) { "d"; $p }
elseif (Test-Path -LiteralPath $p -PathType Leaf) { "f"; $p }
else { exit 5 }
