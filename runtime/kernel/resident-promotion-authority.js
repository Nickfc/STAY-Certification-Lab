'use strict';

const fs =
  require('node:fs');

const crypto =
  require('node:crypto');

const {
  stableStringify
} = require(
  './canonical-json'
);

const {
  digest
} = require(
  './package-policy'
);


const FORMAT =
  'stay-resident-promotion-v1';

const AUTHORIZATION_CLASS =
  'sntss-resident-zero-authority';

const CHRONOBIOLOGY_AUTHORIZATION_CLASS =
  'chronobiology-resident-shadow-none';

const HASH =
  /^sha256:[0-9a-f]{64}$/;

const ACTIONS =
  new Set([
    'attach-resident',
    'reattach-resident'
  ]);


function fail(
  message,
  code =
    'RESIDENT_PROMOTION_DENIED'
) {
  throw Object.assign(
    new Error(message),
    { code }
  );
}


function identityHash(
  identity
) {
  return digest(
    stableStringify(
      identity
    )
  );
}


function authorizationClassForContract(contract) {
  if (
    contract?.coreId === 'sntss' &&
    contract?.residencyId === 'resident:sntss' &&
    contract?.productionEligible === false &&
    (
      contract?.signalling === undefined ||
      contract?.signalling === 'FORBIDDEN'
    ) &&
    Array.isArray(contract?.outputs) &&
    contract.outputs.length === 0
  ) return AUTHORIZATION_CLASS;

  if (
    contract?.coreId === 'chronobiology' &&
    contract?.residencyId === 'resident:chronobiology' &&
    contract?.productionEligible === false &&
    contract?.authorityMode === 'shadow' &&
    contract?.signalling === 'LAB_SHADOW_ONLY' &&
    Array.isArray(contract?.outputs) &&
    contract.outputs.length === 1 &&
    contract.outputs[0] === 'chronobiology.phase.summary'
  ) return CHRONOBIOLOGY_AUTHORIZATION_CLASS;

  fail('resident promotion contract has no bounded authorization class', 'RESIDENT_PROMOTION_CLASS');
}


function certificateFileName(
  residencyId
) {
  const safe =
    String(
      residencyId
    ).replace(
      /[^a-zA-Z0-9_.-]/g,
      '-'
    );

  if (
    !safe ||
    safe.length > 200
  ) {
    fail(
      'resident certificate identity is invalid',
      'RESIDENT_PROMOTION_IDENTITY'
    );
  }

  return `${safe}.json`;
}


function verifyResidentPromotionCertificate(
  record,
  publicKey,
  {
    inspected,
    action,
    identity,
    contract,
    nowMs =
      Date.now()
  }
) {
  if (
    !ACTIONS.has(
      action
    )
  ) {
    fail(
      `resident promotion action is invalid: ${action}`,
      'RESIDENT_PROMOTION_ACTION'
    );
  }

  if (
    !record ||
    record.format !==
      FORMAT ||
    !record.body ||
    typeof record.signature !==
      'string'
  ) {
    fail(
      'resident promotion certificate header is invalid'
    );
  }


  const body =
    record.body;


  const expectedKeys =
    [
      'allowedActions',
      'allowedInputs',
      'allowedOutputs',
      'authorizationClass',
      'certificateId',
      'coreId',
      'expiresAtMs',
      'issuedAtMs',
      'manifestHash',
      'moduleHash',
      'organismId',
      'organismIdentityHash',
      'packagePolicyHash',
      'residencyId',
      'role',
      'version'
    ].sort();


  const actualKeys =
    Object.keys(
      body
    ).sort();


  if (
    actualKeys.length !==
      expectedKeys.length ||
    actualKeys.some(
      (key, index) =>
        key !==
          expectedKeys[index]
    )
  ) {
    fail(
      'resident promotion certificate body is not canonical'
    );
  }


  if (
    !Array.isArray(
      body.allowedActions
    ) ||
    !body.allowedActions
      .includes(
        action
      ) ||
    body.allowedActions.some(
      candidate =>
        !ACTIONS.has(
          candidate
        )
    )
  ) {
    fail(
      `resident certificate does not permit ${action}`,
      'RESIDENT_PROMOTION_ACTION'
    );
  }


  const definition =
    inspected.definition;

  const manifest =
    definition.manifest;


  if (body.authorizationClass !== authorizationClassForContract(contract)) {
    fail(
      'resident promotion authorization class is invalid',
      'RESIDENT_PROMOTION_CLASS'
    );
  }


  if (
    body.residencyId !==
      contract.residencyId ||
    body.role !==
      contract.role ||
    body.coreId !==
      contract.coreId ||
    body.coreId !==
      manifest.coreId ||
    body.version !==
      manifest.version
  ) {
    fail(
      'resident promotion identity contract mismatch',
      'RESIDENT_PROMOTION_IDENTITY'
    );
  }


  if (
    manifest.productionEligible !==
      false
  ) {
    fail(
      'resident must remain production-ineligible',
      'RESIDENT_PROMOTION_AUTHORITY'
    );
  }


  if (
    !Array.isArray(
      body.allowedInputs
    ) ||
    stableStringify(
      body.allowedInputs
    ) !==
      stableStringify(
        [...manifest.inputs]
      ) ||
    stableStringify(
      body.allowedInputs
    ) !==
      stableStringify(
        [...contract.inputs]
      )
  ) {
    fail(
      'resident promotion input contract mismatch',
      'RESIDENT_PROMOTION_INPUTS'
    );
  }


  if (!Array.isArray(body.allowedOutputs) ||
    stableStringify(body.allowedOutputs) !== stableStringify([...manifest.outputs]) ||
    stableStringify(body.allowedOutputs) !== stableStringify([...contract.outputs])) {
    fail(
      'resident promotion output contract mismatch',
      'RESIDENT_PROMOTION_OUTPUTS'
    );
  }


  if (
    body.organismId !==
      identity.organismId ||
    body.organismIdentityHash !==
      identityHash(
        identity
      )
  ) {
    fail(
      'resident promotion organism binding mismatch',
      'RESIDENT_PROMOTION_ORGANISM'
    );
  }


  if (
    body.moduleHash !==
      definition.moduleDigest ||
    !HASH.test(
      body.moduleHash || ''
    ) ||
    body.manifestHash !==
      inspected.manifestHash ||
    !HASH.test(
      body.manifestHash || ''
    )
  ) {
    fail(
      'resident promotion executable identity mismatch',
      'RESIDENT_PROMOTION_CANDIDATE'
    );
  }


  if (
    body.packagePolicyHash !==
      definition.packagePolicyHash ||
    body.packagePolicyHash !==
      contract.packagePolicyHash ||
    !HASH.test(
      body.packagePolicyHash || ''
    )
  ) {
    fail(
      'resident promotion package policy mismatch',
      'RESIDENT_PROMOTION_PACKAGE'
    );
  }


  if (
    !Number.isSafeInteger(
      body.issuedAtMs
    ) ||
    !Number.isSafeInteger(
      body.expiresAtMs
    ) ||
    body.issuedAtMs >
      nowMs + 300000 ||
    body.expiresAtMs <
      nowMs ||
    body.expiresAtMs <=
      body.issuedAtMs
  ) {
    fail(
      'resident promotion certificate is outside its validity window',
      'RESIDENT_PROMOTION_WINDOW'
    );
  }


  if (
    typeof body.certificateId !==
      'string' ||
    body.certificateId.length <
      16 ||
    body.certificateId.length >
      200
  ) {
    fail(
      'resident promotion certificate identity is invalid',
      'RESIDENT_PROMOTION_IDENTITY'
    );
  }


  let signature;

  try {
    signature =
      Buffer.from(
        record.signature,
        'base64'
      );
  } catch {
    fail(
      'resident promotion signature encoding is invalid',
      'RESIDENT_PROMOTION_SIGNATURE'
    );
  }


  if (
    !signature.length ||
    !crypto.verify(
      null,

      Buffer.from(
        stableStringify(
          body
        )
      ),

      publicKey,

      signature
    )
  ) {
    fail(
      'resident promotion signature is invalid',
      'RESIDENT_PROMOTION_SIGNATURE'
    );
  }


  return Object.freeze({
    ok:
      true,

    certificateId:
      body.certificateId,

    residencyId:
      body.residencyId,

    coreId:
      body.coreId,

    version:
      body.version,

    action,

    authorizationClass:
      body.authorizationClass
  });
}


function loadAndVerifyResidentPromotion({
  inspected,
  action,
  identity,
  contract,

  required =
    process.env
      .STAY_REQUIRE_CORE_PROMOTION_CERT ===
        '1',

  publicKeyPath =
    process.env
      .STAY_CORE_PROMOTION_PUBLIC_KEY ||
    '/etc/stay/release-authority.pub',

  certificateDir =
    process.env
      .STAY_RESIDENT_PROMOTION_CERT_DIR ||
    '/etc/stay/resident-promotions',

  nowMs =
    Date.now()
}) {
  if (!required) {
    return Object.freeze({
      ok:
        true,

      laboratoryBypass:
        true,

      residencyId:
        contract.residencyId,

      coreId:
        inspected.definition
          .manifest.coreId,

      version:
        inspected.definition
          .manifest.version,

      action
    });
  }


  const certificatePath =
    `${certificateDir}/${certificateFileName(contract.residencyId)}`;


  let publicKey;
  let record;


  try {
    publicKey =
      fs.readFileSync(
        publicKeyPath,
        'utf8'
      );

    record =
      JSON.parse(
        fs.readFileSync(
          certificatePath,
          'utf8'
        )
      );
  } catch (error) {
    fail(
      `required resident promotion authority is unavailable: ${error.message}`,
      'RESIDENT_PROMOTION_AUTHORITY_MISSING'
    );
  }


  return verifyResidentPromotionCertificate(
    record,
    publicKey,
    {
      inspected,
      action,
      identity,
      contract,
      nowMs
    }
  );
}


module.exports = {
  FORMAT,
  AUTHORIZATION_CLASS,
  CHRONOBIOLOGY_AUTHORIZATION_CLASS,
  authorizationClassForContract,
  identityHash,
  certificateFileName,
  verifyResidentPromotionCertificate,
  loadAndVerifyResidentPromotion
};
