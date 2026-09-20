#!/usr/bin/env node
// ONE-TIME interactive YouTube OAuth bootstrap (Google installed/desktop app
// flow, loopback redirect, per RFC 8252). Run manually, never from a
// scheduled/unattended job. Never uploads anything.
//
// Reads YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET from the private secrets
// file, opens a local loopback HTTP server to catch the OAuth redirect,
// exchanges the code for tokens, and writes ONLY the refresh token back into
// the same file — preserving every other line untouched. Never prints the
// client secret, the authorization code, or the refresh token.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';

const SECRETS_FILE = process.env.MARKETING_SECRETS_FILE || `${process.env.HOME}/.config/veritas-forge-marketing/secrets.env`;
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete the browser consent

function parseEnvFile(text) {
  const vars = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

function readSecrets() {
  const text = readFileSync(SECRETS_FILE, 'utf8');
  return { text, vars: parseEnvFile(text) };
}

/**
 * Replaces (or appends) a KEY=value line without disturbing anything else in
 * the file — including comments and commented-out placeholder lines for
 * OTHER variables, which are left exactly as they were.
 */
function writeSecretValue(originalText, key, value) {
  const lines = originalText.split('\n');
  const pattern = new RegExp(`^#?\\s*${key}\\s*=.*$`);
  let replaced = false;
  const next = lines.map((line) => {
    if (pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) next.push(`${key}=${value}`);
  return next.join('\n');
}

async function openInBrowser(url) {
  // Best-effort only — printing the URL is the guaranteed path. This is a
  // WSL2 environment, so hand off to the Windows side via powershell.exe.
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process "${url}"`], (err) => resolve(!err));
  });
}

async function waitForCallback(expectedState, port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>Authorization denied or failed.</h1>You can close this tab.');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400).end('State mismatch.');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF, aborting.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        '<h1>Authorization received.</h1>You can close this tab and return to the terminal.'
      );
      server.close();
      resolve(code);
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1');

    setTimeout(() => {
      server.close();
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s waiting for OAuth callback.`));
    }, TIMEOUT_MS);
  });
}

async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${data.error ?? response.status} ${data.error_description ?? ''}`);
  }
  return data;
}

async function main() {
  const { text, vars } = readSecrets();
  const clientId = vars.YOUTUBE_CLIENT_ID;
  const clientSecret = vars.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('YOUTUBE_CLIENT_ID and/or YOUTUBE_CLIENT_SECRET not found (uncommented, with a value) in', SECRETS_FILE);
    process.exitCode = 1;
    return;
  }

  const port = 8945; // fixed loopback port — Google's Desktop client type allows any loopback redirect, this just keeps it predictable
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // force consent so a refresh_token is returned even on repeat grants
  authUrl.searchParams.set('state', state);

  console.log('\nOpen this URL and authorize the Google account that owns the target YouTube channel:\n');
  console.log(authUrl.toString());
  console.log(`\nWaiting up to ${TIMEOUT_MS / 1000}s for authorization at ${redirectUri} ...`);

  await openInBrowser(authUrl.toString()); // best-effort; the printed URL above is the guaranteed path

  const code = await waitForCallback(state, port);
  console.log('Authorization code received. Exchanging for tokens...');

  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri });

  if (!tokens.refresh_token) {
    console.error(
      'No refresh_token was returned. This usually means the account already granted this exact scope previously ' +
      'and Google did not re-issue one even with prompt=consent — try revoking prior access at ' +
      'https://myaccount.google.com/permissions and re-running this script.'
    );
    process.exitCode = 1;
    return;
  }

  const updatedText = writeSecretValue(text, 'YOUTUBE_REFRESH_TOKEN', tokens.refresh_token);
  writeFileSync(SECRETS_FILE, updatedText);
  chmodSync(SECRETS_FILE, 0o600);

  console.log(`\nYOUTUBE_REFRESH_TOKEN written to ${SECRETS_FILE} (value not shown). File permissions: 600.`);
  console.log('Scope granted:', tokens.scope ?? SCOPE);
  console.log('No video was uploaded. Run: node tools/marketing/cli.mjs auth-check youtube');
}

main().catch((err) => {
  console.error('\nOAuth bootstrap failed:', err.message);
  process.exitCode = 1;
});
