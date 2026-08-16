'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { stableStringify } = require('./canonical-json');
const { digest } = require('./package-policy');

const FORMAT = 'stay-core-promotion-v1';
const HASH = /^sha256:[0-9a-f]{64}$/;

function fail(message, code = 'CORE_PROMOTION_DENIED') { throw Object.assign(new Error(message), { code }); }
function identityHash(identity) { return digest(stableStringify(identity)); }
function moduleHash(definition) { return digest(fs.readFileSync(definition.modulePath)); }
function manifestHash(definition) { return digest(stableStringify(definition.manifest)); }

function verifyPromotionCertificate(record, publicKey, { definition, action, identity, nowMs = Date.now() }) {
  if (!record || record.format !== FORMAT || !record.body || typeof record.signature !== 'string') fail('promotion certificate header is invalid');
  const body = record.body;
  const expectedKeys = [
    'allowedActions', 'allowedInputs', 'allowedOutputs', 'authorizationClass', 'certificateId', 'coreId',
    'expiresAtMs', 'issuedAtMs', 'manifestHash', 'moduleHash', 'organismId', 'organismIdentityHash',
    'packagePolicyHash', 'r11CertificationHash', 'version'
  ].sort();
  const actualKeys = Object.keys(body).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) fail('promotion certificate body is not canonical');
  if (!Array.isArray(body.allowedActions) || !body.allowedActions.includes(action)) fail(`promotion certificate does not permit ${action}`);
  if (!Array.isArray(body.allowedInputs) || stableStringify(body.allowedInputs) !== stableStringify([...definition.manifest.inputs])) fail('promotion certificate input contract mismatch');
  if (!Array.isArray(body.allowedOutputs) || stableStringify(body.allowedOutputs) !== stableStringify([...definition.manifest.outputs])) fail('promotion certificate output contract mismatch');
  if (body.coreId !== definition.manifest.coreId || body.version !== definition.manifest.version) fail('promotion certificate core identity mismatch');
  if (body.organismId !== identity.organismId || body.organismIdentityHash !== identityHash(identity)) fail('promotion certificate organism binding mismatch');
  if (body.moduleHash !== moduleHash(definition) || body.manifestHash !== manifestHash(definition)) fail('promotion certificate candidate hash mismatch');
  const policyHash = definition.packagePolicy?.policyHash || null;
  if (!policyHash || body.packagePolicyHash !== policyHash || !HASH.test(body.packagePolicyHash)) fail('promotion certificate package policy mismatch');
  if (!Number.isSafeInteger(body.issuedAtMs) || !Number.isSafeInteger(body.expiresAtMs) || body.issuedAtMs > nowMs + 300000 || body.expiresAtMs < nowMs || body.expiresAtMs <= body.issuedAtMs) fail('promotion certificate is outside its validity window');
  if (typeof body.certificateId !== 'string' || body.certificateId.length < 16) fail('promotion certificate identity is invalid');

  if (definition.manifest.coreId === 'sntss') {
    const neutral = definition.manifest.stage === 'neutral-production' && definition.manifest.version === '0.0.0-neutral';
    if (neutral) {
      if (body.authorizationClass !== 'sntss-neutral-install' || definition.manifest.outputs.length !== 0 || !['install', 'stage'].includes(action)) {
        fail('neutral SNTSS promotion contract is invalid', 'SNTSS_PROMOTION_NEUTRAL_ONLY');
      }
    } else if (action === 'stage') {
      if (body.authorizationClass !== 'sntss-shadow-evaluation' || definition.manifest.outputs.length !== 0) {
        fail('pre-R11 SNTSS shadow certificate may not authorize biological outputs', 'SNTSS_PROMOTION_SHADOW_ONLY');
      }
    } else {
      if (body.authorizationClass !== 'sntss-r11-certified-activation' || definition.manifest.productionEligible !== true || !HASH.test(body.r11CertificationHash || '')) {
        fail('active SNTSS requires R11-certified production eligibility', 'SNTSS_PROMOTION_R11_REQUIRED');
      }
    }
  } else if (body.authorizationClass !== 'core-release-authorization') {
    fail('generic core promotion class is invalid');
  }

  const signature = Buffer.from(record.signature, 'base64');
  if (!crypto.verify(null, Buffer.from(stableStringify(body)), publicKey, signature)) fail('promotion certificate signature is invalid', 'CORE_PROMOTION_SIGNATURE');
  return Object.freeze({ ok: true, certificateId: body.certificateId, coreId: body.coreId, version: body.version, action, authorizationClass: body.authorizationClass });
}

function loadAndVerifyPromotion({ definition, action, identity, required = process.env.STAY_REQUIRE_CORE_PROMOTION_CERT === '1' }) {
  if (definition.manifest.coreId === 'fetus-legacy') return { ok: true, legacyExemption: true };
  if (!required) return { ok: true, laboratoryBypass: true };
  const publicKeyPath = process.env.STAY_CORE_PROMOTION_PUBLIC_KEY || '/etc/stay/release-authority.pub';
  const certificateDir = process.env.STAY_CORE_PROMOTION_CERT_DIR || '/etc/stay/core-promotions';
  const safeCoreId = String(definition.manifest.coreId).replace(/[^a-zA-Z0-9_.-]/g, '-');
  const certificatePath = `${certificateDir}/${safeCoreId}.json`;
  let publicKey; let record;
  try {
    publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    record = JSON.parse(fs.readFileSync(certificatePath, 'utf8'));
  } catch (error) {
    fail(`required promotion authority is unavailable: ${error.message}`, 'CORE_PROMOTION_AUTHORITY_MISSING');
  }
  return verifyPromotionCertificate(record, publicKey, { definition, action, identity });
}

module.exports = { FORMAT, identityHash, moduleHash, manifestHash, verifyPromotionCertificate, loadAndVerifyPromotion };
