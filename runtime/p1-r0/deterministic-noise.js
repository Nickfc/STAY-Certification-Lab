'use strict';

const MASK_64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_1 = 0xbf58476d1ce4e5b9n;
const MIX_2 = 0x94d049bb133111ebn;
const HEX_64 = /^[0-9a-f]{16}$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function hex64(value) {
  return (value & MASK_64).toString(16).padStart(16, '0');
}

function parseHex64(value) {
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    fail('noise key must be 16 lowercase hexadecimal characters', 'P1_NOISE_KEY');
  }
  return BigInt(`0x${value}`);
}

function fnv1a64(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    fail('noise channel id is invalid', 'P1_NOISE_CHANNEL');
  }
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

function splitmix64(value) {
  let mixed = (value + SPLITMIX_GAMMA) & MASK_64;
  mixed = ((mixed ^ (mixed >> 30n)) * MIX_1) & MASK_64;
  mixed = ((mixed ^ (mixed >> 27n)) * MIX_2) & MASK_64;
  return (mixed ^ (mixed >> 31n)) & MASK_64;
}

function frame64(frameIndex) {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    fail('noise frame index must be a non-negative safe integer', 'P1_NOISE_FRAME');
  }
  return BigInt(frameIndex) & MASK_64;
}

function triangularQ0_48({ noiseKeyHex, channelId, frameIndex }) {
  const z0 = parseHex64(noiseKeyHex) ^ fnv1a64(channelId) ^ frame64(frameIndex);
  const z1 = z0 ^ SPLITMIX_GAMMA;
  const mixed0 = splitmix64(z0);
  const mixed1 = splitmix64(z1);
  const u0 = mixed0 >> 16n;
  const u1 = mixed1 >> 16n;
  return Object.freeze({
    z0Hex: hex64(z0),
    z1Hex: hex64(z1),
    splitmix0Hex: hex64(mixed0),
    splitmix1Hex: hex64(mixed1),
    u0Q0_48Raw: u0.toString(),
    u1Q0_48Raw: u1.toString(),
    differenceQ0_48Raw: (u0 - u1).toString()
  });
}

module.exports = Object.freeze({
  MASK_64,
  SPLITMIX_GAMMA,
  parseHex64,
  fnv1a64,
  splitmix64,
  triangularQ0_48
});
