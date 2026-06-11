#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// Lazy postinstall fallback — bun blocks postinstall by default, leaving
// tools/unpacked empty. Detect that and run unpack-tools.cjs on first use
// so the CLI works regardless of which package manager installed it.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const unpackedDir = join(projectRoot, 'tools', 'unpacked');
const unpackScript = join(projectRoot, 'scripts', 'unpack-tools.cjs');
if (!existsSync(unpackedDir) && existsSync(unpackScript)) {
  try {
    execFileSync(process.execPath, [unpackScript], { stdio: 'inherit' });
  } catch {
    // Non-fatal: the CLI falls back to a system-installed `claude` when
    // bundled tools are missing.
  }
}

// Preserve the bin name the user actually invoked (happy vs happy-plus) so
// help/usage text printed by dist/index.mjs shows runnable commands, even
// though we re-spawn node with the entrypoint path as argv[1].
if (!process.env.HAPPY_BIN_NAME) {
  const invoked = (process.argv[1] || '').split(/[\\/]/).pop().replace(/\.(mjs|cjs|js)$/, '');
  if (invoked) process.env.HAPPY_BIN_NAME = invoked;
}

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  // Get path to the actual CLI entrypoint
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');
  
  // Execute the actual CLI directly with the correct flags
  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...process.argv.slice(2)
    ], {
      stdio: 'inherit',
      env: process.env
    });
  } catch (error) {
    // execFileSync throws if the process exits with non-zero
    process.exit(error.status || 1);
  }
} else {
  // We're running Node with the flags we wanted, import the CLI entrypoint
  // module to avoid creating a new process.
  import("../dist/index.mjs");
}
