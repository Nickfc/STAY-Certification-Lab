'use strict';

const { spawn } = require('node:child_process');

function send(value) { if (process.connected) process.send(value); }

async function pidsPressure() {
  const children = []; let errors = 0; let spawned = 0;
  for (let index = 0; index < 32; index += 1) {
    try {
      const child = spawn('/bin/sleep', ['10'], { stdio: 'ignore' });
      children.push(child);
      child.once('spawn', () => { spawned += 1; });
      child.once('error', () => { errors += 1; });
    } catch { errors += 1; }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled(children.map(child => new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    child.once('exit', resolve); child.once('error', resolve);
  })));
  send({ kind: 'pids', spawned, errors });
  process.exit(errors > 0 ? 0 : 2);
}

function oomPressure() {
  const allocations = [];
  const allocate = () => {
    for (let index = 0; index < 4; index += 1) allocations.push(Buffer.alloc(4 * 1024 * 1024, 0xa5));
    setImmediate(allocate);
  };
  allocate();
}

function cpuPressure() {
  const started = process.hrtime.bigint(); const end = Date.now() + 6000;
  let value = 1;
  while (Date.now() < end) value = Math.imul(value ^ 0x9e3779b9, 2654435761) >>> 0;
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  send({ kind: 'cpu', elapsedMs, value });
  process.exit(0);
}

process.once('message', message => {
  if (message?.kind === 'oom') return oomPressure();
  if (message?.kind === 'pids') return pidsPressure().catch(error => { send({ kind: 'pids', error: error.message }); process.exit(2); });
  if (message?.kind === 'cpu') return cpuPressure();
  process.exit(2);
});
