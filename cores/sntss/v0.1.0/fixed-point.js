'use strict';

const SCALE = 1000000;
const SIGNED_MIN = -SCALE;
const SIGNED_MAX = SCALE;
const WIDE_LIMIT = (1n << 127n) - 1n;

function integer(value, label = 'fixed-point value') {
  if (!Number.isSafeInteger(value)) throw Object.assign(new Error(`${label} is not a safe integer`), { code: 'SNTSS_FIXED_INTEGER' });
  return value;
}

function wide(value, label) {
  integer(value, label);
  const result = BigInt(value);
  if (result < -WIDE_LIMIT || result > WIDE_LIMIT) throw Object.assign(new Error(`${label} exceeds checked wide range`), { code: 'SNTSS_FIXED_OVERFLOW' });
  return result;
}

function narrow(value, label = 'fixed-point result') {
  if (value < -WIDE_LIMIT || value > WIDE_LIMIT) throw Object.assign(new Error(`${label} exceeds checked wide range`), { code: 'SNTSS_FIXED_OVERFLOW' });
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw Object.assign(new Error(`${label} exceeds safe canonical integer range`), { code: 'SNTSS_FIXED_OVERFLOW' });
  return result;
}

function clamp(value, minimum = 0, maximum = SCALE) {
  integer(value);
  integer(minimum, 'minimum');
  integer(maximum, 'maximum');
  if (minimum > maximum) throw Object.assign(new Error('invalid fixed-point clamp range'), { code: 'SNTSS_FIXED_RANGE' });
  return Math.max(minimum, Math.min(maximum, value));
}

// Canonical division rule: checked integer division truncates toward zero.
function mulDiv(left, right, divisor = SCALE) {
  const denominator = wide(divisor, 'divisor');
  if (denominator === 0n) throw Object.assign(new Error('fixed-point division by zero'), { code: 'SNTSS_FIXED_DIV_ZERO' });
  const product = wide(left, 'left') * wide(right, 'right');
  if (product < -WIDE_LIMIT || product > WIDE_LIMIT) throw Object.assign(new Error('fixed-point product exceeds checked wide range'), { code: 'SNTSS_FIXED_OVERFLOW' });
  return narrow(product / denominator);
}

function mul(left, right) { return mulDiv(left, right, SCALE); }
function ratio(numerator, denominator) { return mulDiv(numerator, SCALE, denominator); }

function powScaled(base, exponent) {
  let factor = clamp(integer(base, 'power base'));
  let power = integer(exponent, 'power exponent');
  if (power < 0) throw Object.assign(new Error('fixed-point exponent must be nonnegative'), { code: 'SNTSS_FIXED_EXPONENT' });
  let result = SCALE;
  while (power > 0) {
    if (power % 2 === 1) result = mul(result, factor);
    power = Math.floor(power / 2);
    if (power > 0) factor = mul(factor, factor);
  }
  return result;
}

function approach(value, target, retentionPerStep, steps) {
  integer(value, 'approach value');
  integer(target, 'approach target');
  const retained = powScaled(retentionPerStep, steps);
  return target + mul(value - target, retained);
}

function hill(concentration, affinity, coefficient = 1) {
  const c = BigInt(clamp(concentration));
  const k = BigInt(clamp(affinity, 1, SCALE));
  const n = integer(coefficient, 'Hill coefficient');
  if (n < 1 || n > 4) throw Object.assign(new Error('Hill coefficient must be 1..4'), { code: 'SNTSS_HILL_COEFFICIENT' });
  const cp = c ** BigInt(n);
  const kp = k ** BigInt(n);
  const denominator = cp + kp;
  if (denominator === 0n) return 0;
  return narrow((cp * BigInt(SCALE)) / denominator, 'receptor occupancy');
}

function saturatingCombine(values) {
  if (!Array.isArray(values)) throw Object.assign(new Error('drive vector must be an array'), { code: 'SNTSS_DRIVE_VECTOR' });
  let positiveRemainder = SCALE;
  let negativeRemainder = SCALE;
  for (const value of values.map(entry => clamp(integer(entry, 'drive'), SIGNED_MIN, SIGNED_MAX)).sort((a, b) => a - b)) {
    if (value >= 0) positiveRemainder = mul(positiveRemainder, SCALE - value);
    else negativeRemainder = mul(negativeRemainder, SCALE - Math.abs(value));
  }
  return clamp((SCALE - positiveRemainder) - (SCALE - negativeRemainder), SIGNED_MIN, SIGNED_MAX);
}

module.exports = {
  SCALE, SIGNED_MIN, SIGNED_MAX, integer, clamp, mulDiv, mul, ratio,
  powScaled, approach, hill, saturatingCombine
};
