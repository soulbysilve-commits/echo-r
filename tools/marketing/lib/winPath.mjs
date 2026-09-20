// Bridges Windows-style paths (used wherever this pipeline talks to
// powershell.exe/YMM4 — real Windows code, reached via WSL interop, which
// needs literal "C:\..." paths) to the WSL POSIX path that every Linux-side
// tool needs to open the SAME file: ffmpeg, ffprobe, Node's own fs calls,
// and the YouTube upload's readFile. Passing a raw "C:\..." path to any of
// those silently resolves to "file not found" rather than an obvious error
// (confirmed in this environment: /usr/bin/ffmpeg is a native Linux ELF
// binary with no drive-letter awareness, while powershell.exe is the real
// Windows PE binary at /mnt/c/Windows/... reached through WSL interop) — so
// this is the one place the translation happens, rather than repeating a
// regex at every call site and risking drift.
export function toWslPath(windowsPath) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(windowsPath ?? '');
  if (!match) return windowsPath; // already POSIX (e.g. a test temp dir) — passed through unchanged
  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
}
