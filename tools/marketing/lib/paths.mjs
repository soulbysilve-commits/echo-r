// Durable state boundary (mandate: "operational state is not trapped inside
// a disposable git worktree"). The publication ledger, marketing memory,
// strategy/experiment history, market cache, and run locks all live under
// this directory — NOT inside any git worktree — so that deleting or
// recreating the echo-r-marketing worktree (or eventually reconciling this
// branch into main) never loses operational history.
//
// Override with MARKETING_STATE_DIR for tests or an alternate deployment.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function stateDir(env = process.env) {
  const dir = env.MARKETING_STATE_DIR || join(homedir(), '.local', 'share', 'veritas-forge-marketing');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(...segments) {
  return join(stateDir(), ...segments);
}
