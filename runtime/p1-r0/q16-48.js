'use strict';

const FRACTION_BITS = 48n;
const SCALE = 1n << FRACTION_BITS;
const MIN_RAW = -(1n << 63n);
const MAX_RAW = (1n << 63n) - 1n;
const CANONICAL_RAW = /^(0|-?[1-9][0-9]*)$/;
const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function checked(value) {
  if (typeof value !== 'bigint') {
    fail('Q16.48 raw value must be a bigint', 'P1_Q48_TYPE');
  }
  if (value < MIN_RAW || value > MAX_RAW) {
    fail('Q16.48 raw value overflowed signed 64-bit storage', 'P1_Q48_OVERFLOW');
  }
  return value;
}

function parseRaw(value) {
  if (typeof value !== 'string' || value.length > 20 || !CANONICAL_RAW.test(value) || value === '-0') {
    fail('Q16.48 transport value is not canonical', 'P1_Q48_CANONICAL');
  }
  return checked(BigInt(value));
}

function roundHalfEven(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    fail('Q16.48 rounding operands must be bigint', 'P1_Q48_TYPE');
  }
  if (denominator === 0n) fail('Q16.48 division by zero', 'P1_Q48_DIV_ZERO');
  let left = numerator;
  let right = denominator;
  if (right < 0n) {
    left = -left;
    right = -right;
  }
  const negative = left < 0n;
  const magnitude = negative ? -left : left;
  let quotient = magnitude / right;
  const remainder = magnitude % right;
  const comparison = remainder * 2n - right;
  if (comparison > 0n || (comparison === 0n && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function fromDecimal(value) {
  if (typeof value !== 'string' || value.length > 96) fail('Q16.48 decimal must be a bounded string', 'P1_Q48_DECIMAL');
  const match = DECIMAL.exec(value);
  if (!match || value === '-0') fail('Q16.48 decimal is invalid', 'P1_Q48_DECIMAL');
  const fraction = match[3] || '';
  const denominator = 10n ** BigInt(fraction.length);
  const digits = BigInt(match[2] + fraction);
  const numerator = (match[1] === '-' ? -digits : digits) * SCALE;
  return checked(roundHalfEven(numerator, denominator));
}

function add(left, right) {
  return checked(checked(left) + checked(right));
}

function subtract(left, right) {
  return checked(checked(left) - checked(right));
}

function mul(left, right) {
  return checked(roundHalfEven(checked(left) * checked(right), SCALE));
}

function div(left, right) {
  checked(left);
  checked(right);
  if (right === 0n) fail('Q16.48 division by zero', 'P1_Q48_DIV_ZERO');
  return checked(roundHalfEven(left * SCALE, right));
}

function quantize(value, step) {
  checked(value);
  checked(step);
  if (step <= 0n) fail('Q16.48 quantization step must be positive', 'P1_Q48_STEP');
  return checked(roundHalfEven(value, step) * step);
}

function clamp(value, minimum = MIN_RAW, maximum = MAX_RAW) {
  checked(value);
  checked(minimum);
  checked(maximum);
  if (minimum > maximum) fail('Q16.48 clamp range is invalid', 'P1_Q48_RANGE');
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function saturatingAdd(left, right) {
  checked(left);
  checked(right);
  const result = left + right;
  return result < MIN_RAW ? MIN_RAW : result > MAX_RAW ? MAX_RAW : result;
}

function saturatingSubtract(left, right) {
  checked(left);
  checked(right);
  const result = left - right;
  return result < MIN_RAW ? MIN_RAW : result > MAX_RAW ? MAX_RAW : result;
}

module.exports = Object.freeze({
  FRACTION_BITS,
  SCALE,
  MIN_RAW,
  MAX_RAW,
  checked,
  parseRaw,
  roundHalfEven,
  fromDecimal,
  add,
  subtract,
  mul,
  div,
  quantize,
  clamp,
  saturatingAdd,
  saturatingSubtract
});
