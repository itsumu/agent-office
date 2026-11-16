# Build a multi-size .ico from the site's pixel-art favicon.
# Uses only .NET Framework's System.Drawing (no extra dependencies) and keeps
# the PNG frames (alpha intact) inside the ICO, which Windows 10/11 renders.
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dst
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$srcImg = [System.Drawing.Image]::FromFile((Resolve-Path $Src).Path)
$sizes = @(16, 20, 24, 32, 48)
$entries = New-Object System.Collections.ArrayList
try {
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        # Nearest neighbour keeps the pixel-art edges crisp at every size.
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($srcImg, 0, 0, $s, $s)
      } finally { $g.Dispose() }
      $ms = New-Object System.IO.MemoryStream
      try {
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        [void]$entries.Add(@{ Size = $s; Bytes = $ms.ToArray() })
      } finally { $ms.Dispose() }
    } finally { $bmp.Dispose() }
  }
} finally { $srcImg.Dispose() }

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
try {
  $bw.Write([uint16]0)                 # reserved
  $bw.Write([uint16]1)                 # type: icon
  $bw.Write([uint16]$entries.Count)    # image count
  $offset = 6 + 16 * $entries.Count
  foreach ($e in $entries) {
    $n = $e.Bytes.Length
    $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$dim)              # width
    $bw.Write([byte]$dim)              # height
    $bw.Write([byte]0)                 # palette size
    $bw.Write([byte]0)                 # reserved
    $bw.Write([uint16]1)               # colour planes
    $bw.Write([uint16]32)              # bits per pixel
    $bw.Write([uint32]$n)              # bytes in this frame
    $bw.Write([uint32]$offset)         # offset to this frame
    $offset += $n
  }
  foreach ($e in $entries) { $bw.Write($e.Bytes) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($Dst, $out.ToArray())
} finally {
  $bw.Dispose()
  $out.Dispose()
}
Write-Output "wrote $Dst ($((Get-Item $Dst).Length) bytes, $($entries.Count) sizes)"
