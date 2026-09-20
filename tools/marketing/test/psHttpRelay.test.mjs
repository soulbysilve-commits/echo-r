import test from 'node:test';
import assert from 'node:assert/strict';
import { stripBom, toWindowsPath } from '../lib/psHttpRelay.mjs';

// Regression test: PowerShell's Set-Content/File.WriteAllText with
// -Encoding UTF8 writes a leading BOM, which silently broke JSON.parse the
// first time this relay was actually run against the live bridge.
test('stripBom removes a leading UTF-8 BOM character', () => {
  const withBom = '\uFEFF{"status":"running"}';
  assert.equal(stripBom(withBom), '{"status":"running"}');
});

test('stripBom is a no-op on text without a BOM', () => {
  const plain = '{"status":"running"}';
  assert.equal(stripBom(plain), plain);
});

test('toWindowsPath converts a /mnt/<drive>/... path to a Windows path', () => {
  assert.equal(toWindowsPath('/mnt/c/Users/Silver/VeritasForgeMarketing/marketing_canary.ymmp'), 'C:\\Users\\Silver\\VeritasForgeMarketing\\marketing_canary.ymmp');
});

test('toWindowsPath throws rather than silently mis-relaying a non-/mnt path', () => {
  assert.throws(() => toWindowsPath('/home/silver/somefile'));
});
