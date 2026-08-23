#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');

async function healthRequest(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('health status is not 200'));
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok !== true) throw new Error('health is not ok');
          resolve(parsed);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('health timeout')));
    request.on('error', reject);
  });
}

async function waitForRuntimeReady({
  socketPath = '/run/stay/resident-control.sock',
  healthUrl = 'http://127.0.0.1:8787/healthz',
  attempts = 80,
  intervalMs = 250,
  requestTimeoutMs = 2000,
  socketProbe = null,
  healthProbe = null
} = {}) {
  const probeSocket = socketProbe || (async () => {
    const stat = await fs.lstat(socketPath);
    return stat.isSocket() && !stat.isSymbolicLink();
  });
  const probeHealth = healthProbe || (() => healthRequest(healthUrl, requestTimeoutMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let socketReady = false;
    try { socketReady = await probeSocket(); }
    catch {}
    if (socketReady) {
      try { return await probeHealth(); }
      catch {}
    }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw Object.assign(new Error('socket and HTTP health did not become jointly ready'), { code: 'P1_B0_RUNTIME_NOT_READY' });
}

if (require.main === module) {
  waitForRuntimeReady().then(health => process.stdout.write(JSON.stringify(health) + '\n')).catch(error => {
    console.error(`P1_B0_RUNTIME_READY_ABORT=${error.code || 'FAILED'}`);
    process.exitCode = 1;
  });
}

module.exports = { waitForRuntimeReady };
