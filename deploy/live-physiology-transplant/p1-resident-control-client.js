#!/usr/bin/env node
'use strict';

const net = require('node:net');

const SOCKET = '/run/stay/resident-control.sock';
const FORMAT = 'stay-resident-control-v1';
const OPERATIONS = new Set(['status', 'attach', 'birth', 'detach', 'promote', 'resynchronize']);
const RESIDENCIES = new Set(['resident:sntss', 'resident:chronobiology', 'resident:metab']);

function timeoutMs() {
  const value = Number(process.env.STAY_RESIDENT_CONTROL_TIMEOUT_MS || 5000);
  return Number.isSafeInteger(value) && value >= 1000 && value <= 60000 ? value : 5000;
}

function validateArguments(argv) {
  const [operation, residencyId] = argv;
  if (
    !OPERATIONS.has(operation) ||
    !RESIDENCIES.has(residencyId) ||
    argv.length !== 2 ||
    (operation === 'birth' && residencyId !== 'resident:metab') ||
    (residencyId === 'resident:metab' && !['status', 'birth'].includes(operation))
  ) {
    throw Object.assign(new Error('fixed operation and residency required'), { code: 'RESIDENT_CONTROL_CLIENT_USAGE' });
  }
  return Object.freeze({ operation, residencyId });
}

function main(argv = process.argv.slice(2)) {
  const { operation, residencyId } = validateArguments(argv);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs(), () => socket.destroy(Object.assign(new Error('timeout'), { code: 'RESIDENT_CONTROL_TIMEOUT' })));
    let body = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ format: FORMAT, operation, residencyId }) + '\n'));
    socket.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > 65536) socket.destroy(Object.assign(new Error('response too large'), { code: 'RESIDENT_CONTROL_RESPONSE' }));
    });
    socket.once('end', () => {
      try {
        const response = JSON.parse(body);
        if (response.ok !== true) throw Object.assign(new Error('resident-control operation denied'), { code: response.code || 'RESIDENT_CONTROL_DENIED' });
        process.stdout.write(JSON.stringify(response) + '\n');
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

if (require.main === module) main().catch(error => {
  console.error(`RESIDENT_CONTROL_CLIENT_ABORT=${error.code || 'FAILED'}`);
  process.exitCode = 1;
});

module.exports = { main, timeoutMs, validateArguments };
