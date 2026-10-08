# wasm/ の Rust を WebAssembly にビルドして public/assets/wasm/lab.wasm に置く。
#   pwsh tools/build-wasm.ps1
# 初回だけ: rustup target add wasm32-unknown-unknown
# ビルド済みの lab.wasm をコミットしているので、Cloudflare 側でのビルドは不要。
$ErrorActionPreference = 'Stop'

$crate = Join-Path $PSScriptRoot '..\wasm'
$out = Join-Path $PSScriptRoot '..\public\assets\wasm'

cargo build --release --target wasm32-unknown-unknown --manifest-path (Join-Path $crate 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $crate 'target\wasm32-unknown-unknown\release\lab.wasm') (Join-Path $out 'lab.wasm') -Force
"{0:N1} KB  {1}" -f ((Get-Item (Join-Path $out 'lab.wasm')).Length / 1KB), (Join-Path $out 'lab.wasm')
