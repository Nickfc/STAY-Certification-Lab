'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SntssObservabilityPlane, hash } = require('../runtime/kernel/sntss-observability');
const { createUnixForensicAnchorSink, assertExternalAnchorSocketPath } = require('../runtime/kernel/forensic-anchor-client');
const { createTrustedAnchorServer, loadReceiptLog, MAX_RECEIPTS_PER_MINUTE } = require('../deploy/trusted-forensic-anchor');

function segment({ index = 1, first = 1, count = 8, anchorHash, headHash }) {
  const body = {
    format: 'stay-sntss-forensic-segment-v2',
    segmentIndex: index,
    firstSequence: first,
    lastSequence: first + count - 1,
    recordCount: count,
    anchorHash,
    headHash
  };
  return Object.freeze({ ...body, manifestHash: hash(body) });
}

function transition(index) {
  return {
    transitionId: `transition-${index}`,
    observedAtMs: 1000 + index,
    input: { eventId: `event-${index}`, sequence: index + 1, topic: 'test.event', status: 'accepted', reasonCode: 'TEST_ACCEPTED' },
    beforeStateHash: hash({ before: index }),
    afterStateHash: hash({ after: index }),
    clamps: [],
    circuitChanges: [],
    migrations: [],
    emittedFrameIds: [],
    evidenceCursor: index + 1,
    profileHash: hash({ profile: 'r11-m03' }),
    candidateVersion: '0.1.0',
    checkpointHash: null,
    auditHeadHash: hash({ audit: index })
  };
}

async function rawRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setTimeout(1500, () => socket.destroy(new Error('timeout')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', chunk => {
      response += String(chunk);
      const newline = response.indexOf('\n');
      if (newline >= 0) {
        socket.destroy();
        try { resolve(JSON.parse(response.slice(0, newline))); } catch (error) { reject(error); }
      }
    });
  });
}

test('R11-M03-01 external anchor service independently retains a valid segment and returns a matching receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-m03-'));
  const trustedSocketRoot = path.join(root, 'run');
  const socketPath = path.join(trustedSocketRoot, 'anchor.sock');
  const logPath = path.join(root, 'state', 'anchors.jsonl');
  const initial = hash({ initial: 'r11-m03' });
  const server = await createTrustedAnchorServer({ socketPath, logPath, initialAnchorHash: initial, now: () => '2026-08-16T10:30:00.000Z' });
  t.after(async () => { await server.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const sink = createUnixForensicAnchorSink({ socketPath, trustedSocketRoot, dataDir: path.join(root, 'organism-state') });
  const manifest = segment({ anchorHash: initial, headHash: hash({ head: 1 }) });
  const ack = await sink(manifest);
  assert.equal(ack.manifestHash, manifest.manifestHash);
  assert.equal(ack.receiptSequence, 1);
  assert.match(ack.receiptHash, /^sha256:[0-9a-f]{64}$/);

  const verified = loadReceiptLog(logPath, initial);
  assert.equal(verified.receipts.length, 1);
  assert.equal(verified.receiptHeadHash, ack.receiptHash);
  assert.equal(verified.segmentHeadHash, manifest.headHash);
  const raw = await fs.readFile(logPath, 'utf8');
  assert.doesNotMatch(raw, /event-|transition-|payload|beforeState|afterState/);
});

test('R11-M03-02 trusted anchor daemon rejects tampered or non-contiguous manifests independently of the client', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-m03-reject-'));
  const trustedSocketRoot = path.join(root, 'run');
  const socketPath = path.join(trustedSocketRoot, 'anchor.sock');
  const logPath = path.join(root, 'state', 'anchors.jsonl');
  const initial = hash({ initial: 'reject' });
  const server = await createTrustedAnchorServer({ socketPath, logPath, initialAnchorHash: initial });
  t.after(async () => { await server.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });

  const good = segment({ anchorHash: initial, headHash: hash({ head: 'good' }) });
  const badHash = { ...good, headHash: hash({ head: 'tampered' }) };
  const rejected = await rawRequest(socketPath, badHash);
  assert.equal(rejected.ok, false);
  assert.match(rejected.code, /TAMPER/);
  await assert.rejects(() => fs.stat(logPath), error => error.code === 'ENOENT');

  const sink = createUnixForensicAnchorSink({ socketPath, trustedSocketRoot, dataDir: path.join(root, 'data') });
  await sink(good);
  const wrongContinuation = segment({ index: 2, first: 9, count: 8, anchorHash: hash({ wrong: 'anchor' }), headHash: hash({ head: 2 }) });
  await assert.rejects(() => sink(wrongContinuation), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_ACK');
  assert.equal(loadReceiptLog(logPath, initial).receipts.length, 1);
});

test('R11-M03-03 altered external receipt history makes trusted anchor restart fail closed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-m03-tamper-'));
  const trustedSocketRoot = path.join(root, 'run');
  const socketPath = path.join(trustedSocketRoot, 'anchor.sock');
  const logPath = path.join(root, 'state', 'anchors.jsonl');
  const initial = hash({ initial: 'tamper-log' });
  const server = await createTrustedAnchorServer({ socketPath, logPath, initialAnchorHash: initial });
  const sink = createUnixForensicAnchorSink({ socketPath, trustedSocketRoot, dataDir: path.join(root, 'data') });
  await sink(segment({ anchorHash: initial, headHash: hash({ head: 1 }) }));
  await server.close();

  const receipt = JSON.parse((await fs.readFile(logPath, 'utf8')).trim());
  receipt.headHash = hash({ forged: true });
  await fs.writeFile(logPath, JSON.stringify(receipt) + '\n');
  await assert.rejects(
    () => createTrustedAnchorServer({ socketPath, logPath, initialAnchorHash: initial }),
    error => /TAMPER|CHAIN/.test(error.code)
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('R11-M03-04 external anchor outage degrades observability only and never rejects chemistry-side capture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-m03-down-'));
  try {
    const trustedSocketRoot = path.join(root, 'missing');
    const missingSocket = path.join(trustedSocketRoot, 'anchor.sock');
    const sink = createUnixForensicAnchorSink({ socketPath: missingSocket, trustedSocketRoot, timeoutMs: 150, dataDir: path.join(root, 'data') });
    const plane = new SntssObservabilityPlane({ anchorHash: hash({ initial: 'observer' }), anchorSink: sink, forensicCapacity: 8 });
    let result;
    for (let index = 0; index < 9; index++) result = plane.capture(transition(index));
    assert.equal(result.captured, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    const health = plane.operatorHealth();
    assert.ok(health.sinkFailures >= 1);
    assert.equal(health.ok, false);
    const followup = plane.capture(transition(10));
    assert.equal(followup.captured, true, 'observer sink failure must not become a state-control exception');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('R11-M03-05 anchor socket is pinned to a separately owned trusted runtime root and service is hardened', async () => {
  assert.throws(() => assertExternalAnchorSocketPath('/var/lib/stay/data/anchor.sock'), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_INVALID');
  assert.throws(() => assertExternalAnchorSocketPath('/var/lib/stay/anchor.sock'), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_INVALID');
  assert.throws(() => assertExternalAnchorSocketPath('/run/stay/anchor.sock'), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_INVALID');
  assert.throws(() => assertExternalAnchorSocketPath('/opt/stay/current/anchor.sock'), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_INVALID');
  assert.throws(() => assertExternalAnchorSocketPath('/tmp/fake-anchor.sock'), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_INVALID');
  assert.equal(assertExternalAnchorSocketPath('/run/stay-forensic-anchor/anchor.sock'), '/run/stay-forensic-anchor/anchor.sock');
  assert.equal(
    assertExternalAnchorSocketPath('/tmp/r11-anchor/anchor.sock', '/var/lib/stay/data', '/tmp/r11-anchor'),
    '/tmp/r11-anchor/anchor.sock',
    'laboratories may explicitly inject a different trusted socket root'
  );

  const unit = await fs.readFile(path.join(__dirname, '..', 'deploy', 'systemd', 'stay-forensic-anchor.service'), 'utf8');
  assert.match(unit, /^User=stayanchor$/m);
  assert.match(unit, /^Group=staydeploy$/m);
  assert.match(unit, /^StateDirectory=stay-forensic-anchor$/m);
  assert.match(unit, /^StateDirectoryMode=0700$/m);
  assert.match(unit, /^RuntimeDirectory=stay-forensic-anchor$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0750$/m);
  assert.match(unit, /^PrivateNetwork=true$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /\/usr\/local\/lib\/stay\/trusted-forensic-anchor\.js/);
  assert.doesNotMatch(unit, /\/var\/lib\/stay\/data/);
});

test('R11-M03-06 external witness rate is bounded so forged-but-contiguous manifests cannot grow disk without limit', async t => {
  assert.equal(MAX_RECEIPTS_PER_MINUTE, 60);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stay-r11-m03-rate-'));
  const trustedSocketRoot = path.join(root, 'run');
  const socketPath = path.join(trustedSocketRoot, 'anchor.sock');
  const logPath = path.join(root, 'state', 'anchors.jsonl');
  const initial = hash({ initial: 'rate' });
  const now = () => '2026-08-16T10:31:00.000Z';
  const server = await createTrustedAnchorServer({ socketPath, logPath, initialAnchorHash: initial, now, maxReceiptsPerMinute: 2 });
  t.after(async () => { await server.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const sink = createUnixForensicAnchorSink({ socketPath, trustedSocketRoot, dataDir: path.join(root, 'data') });

  const first = segment({ index: 1, first: 1, anchorHash: initial, headHash: hash({ rateHead: 1 }) });
  const second = segment({ index: 2, first: 9, anchorHash: first.headHash, headHash: hash({ rateHead: 2 }) });
  const third = segment({ index: 3, first: 17, anchorHash: second.headHash, headHash: hash({ rateHead: 3 }) });
  await sink(first);
  await sink(second);
  await assert.rejects(() => sink(third), error => error.code === 'SNTSS_EXTERNAL_ANCHOR_ACK');
  const verified = loadReceiptLog(logPath, initial);
  assert.equal(verified.receipts.length, 2);
  assert.equal(verified.segmentHeadHash, second.headHash);
});
