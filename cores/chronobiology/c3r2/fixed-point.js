'use strict';

const {
  SIN_Q30,
  TRIG_TABLE_HASH,
  TRIG_TABLE_RESOLUTION,
} = require('./trig-table');

const ENGINE_VERSION = 'chronobiology-fixed-point-v1';
const PHASE_BITS = 32n;
const PHASE_MODULUS = 1n << PHASE_BITS;
const PHASE_MASK = PHASE_MODULUS - 1n;
const PHASE_MODULUS_NUMBER = 4_294_967_296;
const PHASE_HALF_NUMBER = 2_147_483_648;
const Q30_ONE = 1_073_741_824;
const Q31_ONE = 2_147_483_647;
const TABLE_BITS = 12n;
const TABLE_FRACTION_BITS = PHASE_BITS - TABLE_BITS;
const TABLE_FRACTION_MASK = (1n << TABLE_FRACTION_BITS) - 1n;
const TABLE_FRACTION_SCALE_NUMBER = 1_048_576;

function fail(message, code = 'CHRONOBIOLOGY_NUMERICAL_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value)) fail(`${label} is not a safe integer`);
  return value;
}

function unsigned(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  safeInteger(value, label);
  if (value < 0 || value > maximum) fail(`${label} is outside its range`);
  return value;
}

function wrapPhase(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    const wrapped = value % PHASE_MODULUS_NUMBER;
    return wrapped < 0 ? wrapped + PHASE_MODULUS_NUMBER : wrapped;
  }
  const wrapped = BigInt(value) & PHASE_MASK;
  return Number(wrapped);
}

function signedPhaseDifference(left, right) {
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) {
    const raw = wrapPhase(left - right);
    return raw >= PHASE_HALF_NUMBER ? raw - PHASE_MODULUS_NUMBER : raw;
  }
  const raw = (BigInt(left) - BigInt(right)) & PHASE_MASK;
  const signed = raw >= (PHASE_MODULUS >> 1n) ? raw - PHASE_MODULUS : raw;
  return Number(signed);
}

function clamp(value, minimum, maximum) {
  safeInteger(value, 'fixed-point value');
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function roundDivide(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) fail('fixed-point denominator must be positive');
  const sign = n < 0n ? -1n : 1n;
  const magnitude = n < 0n ? -n : n;
  return sign * ((magnitude + (d >> 1n)) / d);
}

function multiplyShift(left, right, shift) {
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right)
    && Math.abs(left) <= 0xffff_ffff && Math.abs(right) <= 0xffff_ffff
    && (shift === 30 || shift === 31)) {
    const sign = Math.sign(left) * Math.sign(right);
    if (sign === 0) return 0;
    const base = 32_768;
    const leftMagnitude = Math.abs(left);
    const rightMagnitude = Math.abs(right);
    const leftHigh = Math.floor(leftMagnitude / base);
    const leftLow = leftMagnitude - leftHigh * base;
    const rightHigh = Math.floor(rightMagnitude / base);
    const rightLow = rightMagnitude - rightHigh * base;
    const high = leftHigh * rightHigh;
    const low = (leftHigh * rightLow + leftLow * rightHigh) * base
      + leftLow * rightLow;
    const magnitude = shift === 30
      ? high + Math.floor((low + 536_870_912) / 1_073_741_824)
      : Math.floor(high / 2) + Math.floor(
        ((high % 2) * 1_073_741_824 + low + 1_073_741_824) / 2_147_483_648,
      );
    const output = sign < 0 ? -magnitude : magnitude;
    safeInteger(output, 'fixed-point product');
    return output;
  }
  const scale = 1n << BigInt(shift);
  const rounded = roundDivide(BigInt(left) * BigInt(right), scale);
  const output = Number(rounded);
  safeInteger(output, 'fixed-point product');
  return output;
}

function multiplyQ30(left, right) {
  return multiplyShift(left, right, 30);
}

function multiplyQ31(left, right) {
  return multiplyShift(left, right, 31);
}

function phaseAdvance(periodUs, durationUs) {
  unsigned(periodUs, 'intrinsic period', Number.MAX_SAFE_INTEGER);
  unsigned(durationUs, 'duration', Number.MAX_SAFE_INTEGER);
  if (periodUs === 0) fail('intrinsic period must be positive');
  const increment = roundDivide(BigInt(durationUs) * PHASE_MODULUS, BigInt(periodUs));
  return wrapPhase(increment);
}

function sinQ30(phaseQ) {
  const phase = wrapPhase(phaseQ);
  const index = Math.floor(phase / TABLE_FRACTION_SCALE_NUMBER);
  const fraction = phase - index * TABLE_FRACTION_SCALE_NUMBER;
  const current = SIN_Q30[index];
  const next = SIN_Q30[(index + 1) % TRIG_TABLE_RESOLUTION];
  const scaled = (next - current) * fraction;
  const rounded = scaled < 0
    ? -Math.floor((-scaled + TABLE_FRACTION_SCALE_NUMBER / 2)
      / TABLE_FRACTION_SCALE_NUMBER)
    : Math.floor((scaled + TABLE_FRACTION_SCALE_NUMBER / 2)
      / TABLE_FRACTION_SCALE_NUMBER);
  return current + rounded;
}

function cosQ30(phaseQ) {
  return sinQ30(wrapPhase(Number(phaseQ) + PHASE_MODULUS_NUMBER / 4));
}

function integerSqrt(value) {
  const input = BigInt(value);
  if (input < 0n) fail('square root input is negative');
  if (input < 2n) return input;
  let left = 1n;
  let right = input >> 1n;
  let answer = 1n;
  while (left <= right) {
    const middle = (left + right) >> 1n;
    const square = middle * middle;
    if (square <= input) {
      answer = middle;
      left = middle + 1n;
    } else {
      right = middle - 1n;
    }
  }
  return answer;
}

function phaseFromVectorQ30(xQ30, yQ30) {
  const x = BigInt(xQ30);
  const y = BigInt(yQ30);
  if (x === 0n && y === 0n) return null;
  let bestIndex = 0;
  let bestDot = null;
  for (let index = 0; index < TRIG_TABLE_RESOLUTION; index += 1) {
    const phase = BigInt(index) << TABLE_FRACTION_BITS;
    const dot = x * BigInt(cosQ30(phase))
      + y * BigInt(sinQ30(phase));
    if (bestDot === null || dot > bestDot) {
      bestDot = dot;
      bestIndex = index;
    }
  }
  return Number(BigInt(bestIndex) << TABLE_FRACTION_BITS);
}

module.exports = {
  ENGINE_VERSION,
  PHASE_MODULUS,
  Q30_ONE,
  Q31_ONE,
  TRIG_TABLE_HASH,
  TRIG_TABLE_RESOLUTION,
  clamp,
  cosQ30,
  integerSqrt,
  multiplyQ30,
  multiplyQ31,
  phaseAdvance,
  phaseFromVectorQ30,
  roundDivide,
  safeInteger,
  signedPhaseDifference,
  sinQ30,
  unsigned,
  wrapPhase,
};
