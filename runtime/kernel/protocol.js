'use strict';

const IPC_PROTOCOL = 'stay-corehost-ipc-v2';
const IPC_PROTOCOL_VERSION = 2;
const MAX_IPC_PAYLOAD_BYTES = 1024 * 1024;
const EVENT_CLASSES = new Set(['critical', 'durable', 'best-effort', 'telemetry']);

function serializedSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { return Number.POSITIVE_INFINITY; }
}

function assertPayload(value, label = 'IPC payload', maximum = MAX_IPC_PAYLOAD_BYTES) {
  const size = serializedSize(value);
  if (!Number.isFinite(size) || size > maximum) {
    const error = new Error(`${label} exceeds ${maximum} bytes`);
    error.code = 'IPC_PAYLOAD_LIMIT';
    throw error;
  }
  return size;
}

function normalizeEventClass(value) {
  return EVENT_CLASSES.has(value) ? value : 'durable';
}

function errorRecord(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    code: error?.code ? String(error.code).slice(0, 80) : null,
    message: String(error?.message || error || 'unknown error').slice(0, 2000),
    stack: String(error?.stack || '').slice(0, 8000),
    operation: error?.coreWorkerOperation || error?.coreHostOperation || null,
    timeoutMs: Number.isFinite(Number(error?.timeoutMs))
      ? Number(error.timeoutMs)
      : null
  };
}

module.exports = {
  IPC_PROTOCOL,
  IPC_PROTOCOL_VERSION,
  MAX_IPC_PAYLOAD_BYTES,
  EVENT_CLASSES,
  serializedSize,
  assertPayload,
  normalizeEventClass,
  errorRecord
};
