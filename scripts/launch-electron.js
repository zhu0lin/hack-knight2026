'use strict';

// Cross-platform replacement for `env -u ELECTRON_RUN_AS_NODE electron .`
// (that POSIX syntax doesn't exist on Windows). Spawning electron directly
// with a scrubbed env works identically on macOS, Linux, and Windows.

const { spawn } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.argv.includes('--sim')) {
  env.VV_SIM = '1';
}

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
