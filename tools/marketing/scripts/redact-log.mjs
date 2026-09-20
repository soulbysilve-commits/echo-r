#!/usr/bin/env node
// Redacts a log file in place. Called by run-marketing-operator.sh after every run.
import { readFileSync, writeFileSync } from 'node:fs';
import { redact } from '../lib/redact.mjs';

const [, , path] = process.argv;
if (!path) {
  console.error('usage: redact-log.mjs <path>');
  process.exit(1);
}
const contents = readFileSync(path, 'utf8');
writeFileSync(path, redact(contents));
