# ローカル確認用の簡易サーバー（Node も Python も不要）
#   pwsh tools/serve.ps1            -> http://localhost:8787/
#   pwsh tools/serve.ps1 -Port 3000
# public/ をそのまま配信する。本番に近づけるため、public/_headers の「/*」ブロック
# （CSP など）を全レスポンスに付け、動画用に Range リクエストにも応える。
param(
  [int]$Port = 8787
)

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public'))
$types = @{
  '.html'  = 'text/html; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.mjs'   = 'text/javascript; charset=utf-8'
  '.json'  = 'application/json'
  '.txt'   = 'text/plain; charset=utf-8'
  '.svg'   = 'image/svg+xml'
  '.png'   = 'image/png'
  '.jpg'   = 'image/jpeg'
  '.webp'  = 'image/webp'
  '.ico'   = 'image/x-icon'
  '.mp4'   = 'video/mp4'
  '.wasm'  = 'application/wasm'
  '.woff2' = 'font/woff2'
}

# _headers から「/*」に対するヘッダーだけを読む（パスごとの出し分けまではしない）
function Read-GlobalHeaders {
  $result = [ordered]@{}
  $file = Join-Path $root '_headers'
  if (-not (Test-Path $file)) { return $result }
  $current = $null
  foreach ($line in Get-Content $file -Encoding UTF8) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -notmatch '^\s') { $current = $line.Trim(); continue }
    if ($current -eq '/*' -and $line -match '^\s+([^:]+):\s*(.+)$') { $result[$Matches[1].Trim()] = $Matches[2].Trim() }
  }
  return $result
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C で停止)"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    try {
      $relative = [Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
      $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
      $status = 200

      # public/ の外と、配信用でない _headers は返さない
      if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $path = $null }
      if ($path -and (Split-Path $path -Leaf) -eq '_headers') { $path = $null }
      if ($path -and (Test-Path $path -PathType Container)) { $path = Join-Path $path 'index.html' }
      if (-not $path -or -not (Test-Path $path -PathType Leaf)) {
        $path = Join-Path $root '404.html'
        $status = 404
      }

      $bytes = [IO.File]::ReadAllBytes($path)
      $start = 0
      $end = $bytes.Length - 1
      if ($status -eq 200 -and $request.Headers['Range'] -match '^bytes=(\d*)-(\d*)$') {
        if ($Matches[1] -ne '') { $start = [int64]$Matches[1] }
        if ($Matches[2] -ne '') { $end = [Math]::Min([int64]$Matches[2], $bytes.Length - 1) }
        if ($start -le $end) {
          $status = 206
          $response.Headers['Content-Range'] = "bytes $start-$end/$($bytes.Length)"
        } else {
          $start = 0
        }
      }

      $type = $types[[IO.Path]::GetExtension($path).ToLowerInvariant()]
      $response.StatusCode = $status
      $response.ContentType = if ($type) { $type } else { 'application/octet-stream' }
      $response.Headers['Cache-Control'] = 'no-store'
      $response.Headers['Accept-Ranges'] = 'bytes'
      $globalHeaders = Read-GlobalHeaders
      foreach ($name in $globalHeaders.Keys) { $response.Headers[$name] = $globalHeaders[$name] }

      $length = $end - $start + 1
      $response.ContentLength64 = $length
      if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($bytes, $start, $length) }
      Write-Host "$status $($request.HttpMethod) /$relative"
    } catch {
      Write-Host "error: $_"
    } finally {
      try { $response.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
}
