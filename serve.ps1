# ==============================================================================
# GeoFinance System — Serveur local (zero dependance : PowerShell pur)
# Necessaire car les Service Workers exigent http://localhost (jamais file://).
# Usage : clic droit > "Executer avec PowerShell", ou :  .\serve.ps1 -Port 8080
# ==============================================================================
param(
    [int]$Port = 8080
)

$root = $PSScriptRoot
$prefix = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Host "Impossible de demarrer le serveur sur $prefix (port deja utilise ?)" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

$mimeTypes = @{
    ".html"        = "text/html; charset=utf-8"
    ".js"          = "text/javascript; charset=utf-8"
    ".css"         = "text/css; charset=utf-8"
    ".json"        = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json"
    ".svg"         = "image/svg+xml"
    ".png"         = "image/png"
    ".ico"         = "image/x-icon"
}

Write-Host ""
Write-Host "  GeoFinance System - serveur local demarre" -ForegroundColor Cyan
Write-Host "  Ouvrez : $prefix" -ForegroundColor Green
Write-Host "  (Ctrl+C dans cette fenetre pour arreter le serveur)" -ForegroundColor DarkGray
Write-Host ""

try { Start-Process $prefix } catch {}

$fullRoot = [System.IO.Path]::GetFullPath($root)

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }
    $request = $context.Request
    $response = $context.Response
    try {
        $relPath = [Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart('/'))
        if ([string]::IsNullOrEmpty($relPath)) { $relPath = "index.html" }
        $filePath = Join-Path $root $relPath

        if ((Test-Path $filePath) -and (Get-Item $filePath).PSIsContainer) {
            $filePath = Join-Path $filePath "index.html"
        }

        $fullFilePath = [System.IO.Path]::GetFullPath($filePath)

        if (-not $fullFilePath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $response.StatusCode = 403
            $forbidden = [System.Text.Encoding]::UTF8.GetBytes("403 - Acces refuse")
            $response.OutputStream.Write($forbidden, 0, $forbidden.Length)
        } elseif (Test-Path $fullFilePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($fullFilePath).ToLower()
            $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($fullFilePath)
            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.StatusCode = 200
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 - Fichier non trouve : $relPath")
            $response.OutputStream.Write($notFound, 0, $notFound.Length)
        }
    } catch {
        try { $response.StatusCode = 500 } catch {}
    } finally {
        $response.OutputStream.Close()
    }
}

$listener.Stop()
