// HTTP relay via powershell.exe, used ONLY as a fetch-compatible transport
// for reaching the ymm4MCP bridge (http://localhost:8765) from WSL2.
//
// Why this exists: the bridge is confirmed genuinely running and reachable
// from Windows itself (`Invoke-WebRequest` from PowerShell succeeds), but
// WSL2's localhost-forwarding does not reach it from this environment
// (confirmed with curl: "Connection refused" on both 127.0.0.1 and ::1,
// despite `Get-NetTCPConnection` showing it listening on the Windows side).
// Rather than modify WSL/Windows network configuration (out of scope — a
// system-wide change, not a per-task one), requests are relayed through
// powershell.exe, which already has a proven-working path to localhost.
//
// Data crosses the WSL/Windows boundary via files under a shared temp
// directory on the Windows side (/mnt/c/... == C:\...), never via
// command-line arguments — avoiding any shell-quoting/injection concerns
// with request bodies (which may contain quotes, JSON, Japanese text).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const RELAY_DIR = '/mnt/c/Users/Silver/AppData/Local/Temp/veritas-forge-ymm4-relay';

// PowerShell's `-Encoding UTF8` (Set-Content/File.WriteAllText via
// [System.Text.Encoding]::UTF8 in some code paths) writes a leading BOM,
// which breaks JSON.parse if not stripped.
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readUtf8NoBom(path) {
  return stripBom(readFileSync(path, 'utf8'));
}

export function toWindowsPath(wslPath) {
  const m = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!m) throw new Error(`toWindowsPath: expected a /mnt/<drive>/... path, got ${wslPath}`);
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

const RELAY_SCRIPT = `
param([string]$Url, [string]$Method, [string]$ReqBodyPath, [string]$RespBodyPath, [string]$MetaPath)
$ErrorActionPreference = 'Stop'
try {
  $params = @{ Uri = $Url; Method = $Method; UseBasicParsing = $true; TimeoutSec = 20 }
  if ($ReqBodyPath -and (Test-Path $ReqBodyPath)) {
    $params['Body'] = [System.IO.File]::ReadAllText($ReqBodyPath, [System.Text.Encoding]::UTF8)
    $params['ContentType'] = 'application/json; charset=utf-8'
  }
  $resp = Invoke-WebRequest @params
  [System.IO.File]::WriteAllText($RespBodyPath, $resp.Content, [System.Text.Encoding]::UTF8)
  (@{ status = [int]$resp.StatusCode; ok = $true } | ConvertTo-Json) | Set-Content -Path $MetaPath -Encoding UTF8
} catch {
  $statusCode = 0
  $body = $_.Exception.Message
  if ($_.Exception.Response) {
    $statusCode = [int]$_.Exception.Response.StatusCode
    try {
      $stream = $_.Exception.Response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $body = $reader.ReadToEnd()
    } catch {}
  }
  [System.IO.File]::WriteAllText($RespBodyPath, $body, [System.Text.Encoding]::UTF8)
  (@{ status = $statusCode; ok = $false } | ConvertTo-Json) | Set-Content -Path $MetaPath -Encoding UTF8
}
`;

let scriptWritten = false;
const SCRIPT_PATH_WSL = join(RELAY_DIR, 'relay.ps1');

function ensureScript() {
  mkdirSync(RELAY_DIR, { recursive: true });
  if (!scriptWritten || !existsSync(SCRIPT_PATH_WSL)) {
    writeFileSync(SCRIPT_PATH_WSL, RELAY_SCRIPT, 'utf8');
    scriptWritten = true;
  }
}

/**
 * fetch-compatible function: psFetch(url, { method, headers, body }) ->
 * { ok, status, headers: { get() }, json(), text() }
 */
export async function psFetch(url, options = {}) {
  ensureScript();
  const dir = mkdtempSync(join(RELAY_DIR.replace(/\/$/, ''), 'req-'));
  const reqBodyPath = join(dir, 'reqbody.txt');
  const respBodyPath = join(dir, 'respbody.txt');
  const metaPath = join(dir, 'meta.json');

  try {
    if (options.body) writeFileSync(reqBodyPath, options.body, 'utf8');

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toWindowsPath(SCRIPT_PATH_WSL),
      '-Url', url,
      '-Method', options.method || 'GET',
      '-ReqBodyPath', options.body ? toWindowsPath(reqBodyPath) : '',
      '-RespBodyPath', toWindowsPath(respBodyPath),
      '-MetaPath', toWindowsPath(metaPath),
    ];

    await execFileAsync('powershell.exe', args, { timeout: 30000 });

    const meta = existsSync(metaPath) ? JSON.parse(readUtf8NoBom(metaPath)) : { status: 0, ok: false };
    const bodyText = existsSync(respBodyPath) ? readUtf8NoBom(respBodyPath) : '';

    return {
      ok: meta.status >= 200 && meta.status < 300,
      status: meta.status,
      headers: { get: () => null },
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
