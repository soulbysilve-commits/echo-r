import test from 'node:test';
import assert from 'node:assert/strict';
import { toWslPath } from '../lib/winPath.mjs';

test('toWslPath translates a Windows drive path to its WSL /mnt/<drive> equivalent', () => {
  assert.equal(toWslPath('C:\\Users\\Silver\\VeritasForgeMarketing\\render\\x.mp4'), '/mnt/c/Users/Silver/VeritasForgeMarketing/render/x.mp4');
});

test('toWslPath lowercases only the drive letter, preserving case elsewhere', () => {
  assert.equal(toWslPath('D:\\Data\\Video.mp4'), '/mnt/d/Data/Video.mp4');
});

test('toWslPath passes an already-POSIX path through unchanged', () => {
  assert.equal(toWslPath('/tmp/pub.mp4'), '/tmp/pub.mp4');
  assert.equal(toWslPath('/mnt/c/already/translated.mp4'), '/mnt/c/already/translated.mp4');
});

test('toWslPath passes null/undefined through unchanged rather than throwing', () => {
  assert.equal(toWslPath(undefined), undefined);
  assert.equal(toWslPath(null), null);
});
