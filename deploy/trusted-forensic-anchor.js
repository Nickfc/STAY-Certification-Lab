'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_MESSAGE_BYTES = 4096;
const MAX_RECEIPTS_PER_MINUTE = 60;
const RECEIPT_FORMAT = 'stay-sntss-external-anchor-receipt-v1';
const SEGMENT_FORMAT = 'stay-sntss-forensic-segment-v2';
const RECEIPT_GENESIS = 'sha256:' + '0'.repeat(64);
const SEGMENT_KEYS = new Set(['format','segmentIndex','firstSequence','lastSequence','recordCount','anchorHash','headHash','manifestHash']);
const RECEIPT_KEYS = new Set(['format','receiptSequence','receivedAt','segmentIndex','firstSequence','lastSequence','recordCount','anchorHash','headHash','manifestHash','previousReceiptHash','receiptHash']);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function hash(value) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function fail(message, code = 'TRUSTED_FORENSIC_ANCHOR_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains unexpected field: ${key}`);
  for (const key of allowed) if (!(key in value)) fail(`${label} is missing field: ${key}`);
}

function positiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be sha256:<64 lowercase hex>`);
  return value;
}

function verifySegmentManifest(manifest) {
  exactKeys(manifest, SEGMENT_KEYS, 'segment manifest');
  if (manifest.format !== SEGMENT_FORMAT) fail('segment format is invalid');
  const segmentIndex = positiveInt(manifest.segmentIndex, 'segmentIndex');
  const firstSequence = positiveInt(manifest.firstSequence, 'firstSequence');
  const lastSequence = positiveInt(manifest.lastSequence, 'lastSequence');
  const recordCount = positiveInt(manifest.recordCount, 'recordCount');
  if (lastSequence !== firstSequence + recordCount - 1) fail('segment sequence range is inconsistent');
  const anchorHash = digest(manifest.anchorHash, 'anchorHash');
  const headHash = digest(manifest.headHash, 'headHash');
  const manifestHash = digest(manifest.manifestHash, 'manifestHash');
  const body = { format: SEGMENT_FORMAT, segmentIndex, firstSequence, lastSequence, recordCount, anchorHash, headHash };
  if (hash(body) !== manifestHash) fail('segment manifest hash mismatch', 'TRUSTED_FORENSIC_ANCHOR_TAMPER');
  return Object.freeze({ ...body, manifestHash });
}

function receiptBody(receipt) {
  return {
    format: RECEIPT_FORMAT,
    receiptSequence: receipt.receiptSequence,
    receivedAt: receipt.receivedAt,
    segmentIndex: receipt.segmentIndex,
    firstSequence: receipt.firstSequence,
    lastSequence: receipt.lastSequence,
    recordCount: receipt.recordCount,
    anchorHash: receipt.anchorHash,
    headHash: receipt.headHash,
    manifestHash: receipt.manifestHash,
    previousReceiptHash: receipt.previousReceiptHash
  };
}

function verifyReceipt(receipt, expectedSequence, previousReceiptHash) {
  exactKeys(receipt, RECEIPT_KEYS, 'anchor receipt');
  if (receipt.format !== RECEIPT_FORMAT) fail('receipt format is invalid');
  if (receipt.receiptSequence !== expectedSequence) fail('receipt sequence is not contiguous', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
  if (!Number.isFinite(Date.parse(receipt.receivedAt))) fail('receipt timestamp is invalid');
  positiveInt(receipt.segmentIndex, 'receipt segmentIndex');
  positiveInt(receipt.firstSequence, 'receipt firstSequence');
  positiveInt(receipt.lastSequence, 'receipt lastSequence');
  positiveInt(receipt.recordCount, 'receipt recordCount');
  digest(receipt.anchorHash, 'receipt anchorHash');
  digest(receipt.headHash, 'receipt headHash');
  digest(receipt.manifestHash, 'receipt manifestHash');
  digest(receipt.previousReceiptHash, 'receipt previousReceiptHash');
  digest(receipt.receiptHash, 'receiptHash');
  if (receipt.previousReceiptHash !== previousReceiptHash) fail('receipt previous hash mismatch', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
  if (hash(receiptBody(receipt)) !== receipt.receiptHash) fail('receipt hash mismatch', 'TRUSTED_FORENSIC_ANCHOR_TAMPER');
  return receipt;
}

function readInitialAnchor({ initialAnchorHash = null, initialAnchorFile = null } = {}) {
  let value = initialAnchorHash;
  if (!value && initialAnchorFile) value = fs.readFileSync(initialAnchorFile, 'utf8').trim();
  return digest(value, 'initial anchor hash');
}

function loadReceiptLog(logPath, initialAnchorHash) {
  if (!fs.existsSync(logPath)) return Object.freeze({ receipts: [], receiptHeadHash: RECEIPT_GENESIS, segmentHeadHash: initialAnchorHash, lastSegmentIndex: 0, lastSequence: 0 });
  const stat = fs.lstatSync(logPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('anchor receipt log must be a regular non-symlink file', 'TRUSTED_FORENSIC_ANCHOR_PATH');
  const source = fs.readFileSync(logPath, 'utf8');
  if (!source) return Object.freeze({ receipts: [], receiptHeadHash: RECEIPT_GENESIS, segmentHeadHash: initialAnchorHash, lastSegmentIndex: 0, lastSequence: 0 });
  if (!source.endsWith('\n')) fail('anchor receipt log has an incomplete tail', 'TRUSTED_FORENSIC_ANCHOR_TAMPER');
  const lines = source.trimEnd().split('\n');
  const receipts = [];
  let receiptHeadHash = RECEIPT_GENESIS;
  let segmentHeadHash = initialAnchorHash;
  let lastSegmentIndex = 0;
  let lastSequence = 0;
  let lastReceivedAtMs = -Infinity;
  for (let index = 0; index < lines.length; index++) {
    let receipt;
    try { receipt = JSON.parse(lines[index]); }
    catch { fail('anchor receipt log contains malformed JSON', 'TRUSTED_FORENSIC_ANCHOR_TAMPER'); }
    verifyReceipt(receipt, index + 1, receiptHeadHash);
    const receivedAtMs = Date.parse(receipt.receivedAt);
    if (receivedAtMs < lastReceivedAtMs) fail('anchor receipt clock is not monotonic', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
    if (receipt.segmentIndex !== lastSegmentIndex + 1) fail('anchored segment index is not contiguous', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
    if (receipt.firstSequence !== lastSequence + 1) fail('anchored record sequence is not contiguous', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
    if (receipt.anchorHash !== segmentHeadHash) fail('anchored segment does not continue previous head', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
    if (receipt.lastSequence !== receipt.firstSequence + receipt.recordCount - 1) fail('anchored segment range is invalid', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
    receipts.push(Object.freeze(receipt));
    receiptHeadHash = receipt.receiptHash;
    segmentHeadHash = receipt.headHash;
    lastSegmentIndex = receipt.segmentIndex;
    lastSequence = receipt.lastSequence;
    lastReceivedAtMs = receivedAtMs;
  }
  return Object.freeze({ receipts, receiptHeadHash, segmentHeadHash, lastSegmentIndex, lastSequence });
}

function appendReceipt(logPath, receipt) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(logPath, flags, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(receipt) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function createAnchorState({ logPath, initialAnchorHash, now = () => new Date().toISOString(), maxReceiptsPerMinute = MAX_RECEIPTS_PER_MINUTE }) {
  if (!Number.isSafeInteger(maxReceiptsPerMinute) || maxReceiptsPerMinute < 1 || maxReceiptsPerMinute > 600) fail('maxReceiptsPerMinute is outside trusted bounds');
  const loaded = loadReceiptLog(logPath, initialAnchorHash);
  let receiptHeadHash = loaded.receiptHeadHash;
  let segmentHeadHash = loaded.segmentHeadHash;
  let lastSegmentIndex = loaded.lastSegmentIndex;
  let lastSequence = loaded.lastSequence;
  let receiptSequence = loaded.receipts.length;
  let lastReceivedAtMs = loaded.receipts.length ? Date.parse(loaded.receipts.at(-1).receivedAt) : -Infinity;
  let recentReceiptTimes = loaded.receipts.slice(-maxReceiptsPerMinute).map(receipt => Date.parse(receipt.receivedAt));

  return {
    status() { return Object.freeze({ receiptCount: receiptSequence, receiptHeadHash, segmentHeadHash, lastSegmentIndex, lastSequence, maxReceiptsPerMinute }); },
    accept(rawManifest) {
      const manifest = verifySegmentManifest(rawManifest);
      if (manifest.segmentIndex !== lastSegmentIndex + 1) fail('segment index does not continue external anchor', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
      if (manifest.firstSequence !== lastSequence + 1) fail('record sequence does not continue external anchor', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
      if (manifest.anchorHash !== segmentHeadHash) fail('segment anchor does not match external head', 'TRUSTED_FORENSIC_ANCHOR_CHAIN');
      const receivedAt = String(now());
      const receivedAtMs = Date.parse(receivedAt);
      if (!Number.isFinite(receivedAtMs)) fail('trusted clock returned invalid receipt time');
      if (receivedAtMs < lastReceivedAtMs) fail('trusted clock moved backwards', 'TRUSTED_FORENSIC_ANCHOR_CLOCK');
      recentReceiptTimes = recentReceiptTimes.filter(value => receivedAtMs - value < 60000);
      if (recentReceiptTimes.length >= maxReceiptsPerMinute) fail('forensic anchor receipt rate exceeded', 'TRUSTED_FORENSIC_ANCHOR_RATE');
      const draft = {
        format: RECEIPT_FORMAT,
        receiptSequence: receiptSequence + 1,
        receivedAt,
        segmentIndex: manifest.segmentIndex,
        firstSequence: manifest.firstSequence,
        lastSequence: manifest.lastSequence,
        recordCount: manifest.recordCount,
        anchorHash: manifest.anchorHash,
        headHash: manifest.headHash,
        manifestHash: manifest.manifestHash,
        previousReceiptHash: receiptHeadHash
      };
      const receipt = Object.freeze({ ...draft, receiptHash: hash(draft) });
      appendReceipt(logPath, receipt);
      receiptSequence = receipt.receiptSequence;
      receiptHeadHash = receipt.receiptHash;
      segmentHeadHash = receipt.headHash;
      lastSegmentIndex = receipt.segmentIndex;
      lastSequence = receipt.lastSequence;
      lastReceivedAtMs = receivedAtMs;
      recentReceiptTimes.push(receivedAtMs);
      return receipt;
    }
  };
}

async function createTrustedAnchorServer({ socketPath, logPath, initialAnchorHash = null, initialAnchorFile = null, now, maxReceiptsPerMinute = MAX_RECEIPTS_PER_MINUTE } = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) fail('anchor socket path must be absolute', 'TRUSTED_FORENSIC_ANCHOR_PATH');
  if (typeof logPath !== 'string' || !path.isAbsolute(logPath)) fail('anchor log path must be absolute', 'TRUSTED_FORENSIC_ANCHOR_PATH');
  const initial = readInitialAnchor({ initialAnchorHash, initialAnchorFile });
  const state = createAnchorState({ logPath, initialAnchorHash: initial, now, maxReceiptsPerMinute });
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  if (fs.existsSync(socketPath)) {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) fail('refusing to replace non-socket anchor path', 'TRUSTED_FORENSIC_ANCHOR_PATH');
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer(socket => {
    socket.setTimeout(1500, () => socket.destroy());
    let input = '';
    let handled = false;
    const reject = error => {
      if (handled) return;
      handled = true;
      const payload = { ok: false, code: error?.code || 'TRUSTED_FORENSIC_ANCHOR_REJECTED' };
      socket.end(JSON.stringify(payload) + '\n');
    };
    socket.on('data', chunk => {
      if (handled) return;
      input += String(chunk);
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) return reject(Object.assign(new Error('anchor request exceeds bound'), { code: 'TRUSTED_FORENSIC_ANCHOR_BOUND' }));
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      if (input.slice(newline + 1).trim()) return reject(Object.assign(new Error('only one anchor manifest is accepted per connection'), { code: 'TRUSTED_FORENSIC_ANCHOR_BOUND' }));
      let manifest;
      try { manifest = JSON.parse(input.slice(0, newline)); }
      catch { return reject(Object.assign(new Error('anchor request is malformed'), { code: 'TRUSTED_FORENSIC_ANCHOR_JSON' })); }
      try {
        const receipt = state.accept(manifest);
        handled = true;
        socket.end(JSON.stringify({ ok: true, manifestHash: receipt.manifestHash, receiptHash: receipt.receiptHash, receiptSequence: receipt.receiptSequence }) + '\n');
      } catch (error) { reject(error); }
    });
    socket.once('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o660); resolve(); }
      catch (error) { server.close(() => reject(error)); }
    });
  });

  return Object.freeze({
    socketPath,
    logPath,
    initialAnchorHash: initial,
    status: () => state.status(),
    close: () => new Promise(resolve => server.close(() => {
      try { if (fs.existsSync(socketPath) && fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch {}
      resolve();
    }))
  });
}

async function main() {
  const socketPath = process.env.STAY_FORENSIC_ANCHOR_SOCKET || '/run/stay-forensic-anchor/anchor.sock';
  const logPath = process.env.STAY_FORENSIC_ANCHOR_LOG || '/var/lib/stay-forensic-anchor/anchors.jsonl';
  const initialAnchorFile = process.env.STAY_FORENSIC_INITIAL_ANCHOR_FILE;
  const instance = await createTrustedAnchorServer({ socketPath, logPath, initialAnchorFile });
  const stop = async () => { await instance.close(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (require.main === module) main().catch(error => {
  console.error('[STAY forensic anchor] fatal:', error.code || 'ERROR');
  process.exit(1);
});

module.exports = {
  HASH,
  RECEIPT_GENESIS,
  MAX_RECEIPTS_PER_MINUTE,
  stableStringify,
  hash,
  verifySegmentManifest,
  verifyReceipt,
  readInitialAnchor,
  loadReceiptLog,
  createTrustedAnchorServer
};
