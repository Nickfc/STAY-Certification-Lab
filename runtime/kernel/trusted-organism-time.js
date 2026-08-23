'use strict';

const fs = require('node:fs');

const STATE_KEY = 'trusted-organism-time';
const STATE_PROTOCOL = 'stay-trusted-organism-time-v1';
const BOOTSTRAP_PROTOCOL = 'stay-trusted-time-bootstrap-v1';
const CONTINUITY_PROOF_PROTOCOL = 'stay-trusted-time-continuity-proof-v1';

const STATUS = Object.freeze({
  TRUSTED: 'TRUSTED',
  UNCERTAIN: 'TRUSTED_TIME_UNCERTAIN'
});

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function safeUnsigned(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      `${label} must be a non-negative safe integer`,
      'TRUSTED_TIME_VALUE_INVALID'
    );
  }
  return value;
}

function boundedString(value, label, maximum = 256) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum
  ) {
    fail(`${label} is invalid`, 'TRUSTED_TIME_VALUE_INVALID');
  }
  return value;
}

function defaultBootId() {
  try {
    return boundedString(
      fs.readFileSync(
        '/proc/sys/kernel/random/boot_id',
        'utf8'
      ).trim(),
      'boot id',
      128
    );
  } catch (error) {
    fail(
      `trusted boot identity is unavailable: ${error.message}`,
      'TRUSTED_TIME_BOOT_ID_UNAVAILABLE'
    );
  }
}

function defaultMonotonicNowUs() {
  const value = process.hrtime.bigint() / 1000n;

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(
      'monotonic time exceeded safe integer range',
      'TRUSTED_TIME_VALUE_INVALID'
    );
  }

  return Number(value);
}

function validateState(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('state is not an object');
    }

    if (input.protocol !== STATE_PROTOCOL) {
      throw new Error('state protocol mismatch');
    }

    boundedString(input.organismId, 'state organism id');
    safeUnsigned(input.trustedTimeUs, 'state trusted time');

    if (
      !Number.isSafeInteger(input.continuityEpoch) ||
      input.continuityEpoch < 1
    ) {
      throw new Error('state continuity epoch is invalid');
    }

    if (
      input.status !== STATUS.TRUSTED &&
      input.status !== STATUS.UNCERTAIN
    ) {
      throw new Error('state status is invalid');
    }

    boundedString(input.bootId, 'state boot id', 128);
    boundedString(input.observedBootId, 'state observed boot id', 128);

    if (input.status === STATUS.TRUSTED) {
      safeUnsigned(
        input.anchorMonotonicUs,
        'state monotonic anchor'
      );

      if (input.bootId !== input.observedBootId) {
        throw new Error(
          'trusted state boot identity is inconsistent'
        );
      }

      if (input.reasonCode !== null) {
        throw new Error(
          'trusted state has uncertainty reason'
        );
      }
    } else {
      if (input.anchorMonotonicUs !== null) {
        throw new Error(
          'uncertain state has trusted monotonic anchor'
        );
      }

      boundedString(
        input.reasonCode,
        'state uncertainty reason',
        128
      );
    }

    if (input.lastProofId !== null) {
      boundedString(
        input.lastProofId,
        'state proof id',
        256
      );
    }

    return {
      protocol: STATE_PROTOCOL,
      organismId: input.organismId,
      trustedTimeUs: input.trustedTimeUs,
      continuityEpoch: input.continuityEpoch,
      status: input.status,
      reasonCode: input.reasonCode,
      bootId: input.bootId,
      observedBootId: input.observedBootId,
      anchorMonotonicUs: input.anchorMonotonicUs,
      lastProofId: input.lastProofId
    };
  } catch (error) {
    fail(
      `trusted organism time state is invalid: ${error.message}`,
      'TRUSTED_TIME_STATE_INVALID'
    );
  }
}

function validateBootstrap(input, organismId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(
      'trusted organism time requires an explicit bootstrap record',
      'TRUSTED_TIME_BOOTSTRAP_REQUIRED'
    );
  }

  if (
    input.protocol !== BOOTSTRAP_PROTOCOL ||
    input.organismId !== organismId
  ) {
    fail(
      'trusted organism time bootstrap is invalid',
      'TRUSTED_TIME_BOOTSTRAP_INVALID'
    );
  }

  safeUnsigned(
    input.trustedTimeUs,
    'bootstrap trusted time'
  );

  boundedString(
    input.proofId,
    'bootstrap proof id',
    256
  );

  return {
    trustedTimeUs: input.trustedTimeUs,
    proofId: input.proofId
  };
}

function inspectContinuityProof(
  proof,
  {
    organismId,
    previous,
    currentBootId
  }
) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return {
      ok: false,
      reasonCode: 'TRUSTED_TIME_CONTINUITY_UNPROVEN'
    };
  }

  try {
    if (proof.protocol !== CONTINUITY_PROOF_PROTOCOL) {
      throw new Error('protocol');
    }

    if (proof.trusted !== true) {
      throw new Error('trust');
    }

    if (proof.organismId !== organismId) {
      throw new Error('organism');
    }

    if (proof.fromBootId !== previous.bootId) {
      throw new Error('from boot');
    }

    if (proof.toBootId !== currentBootId) {
      throw new Error('to boot');
    }

    if (
      proof.anchorTrustedTimeUs !==
      previous.trustedTimeUs
    ) {
      throw new Error('anchor');
    }

    safeUnsigned(
      proof.elapsedSinceAnchorUs,
      'proof elapsed time'
    );

    boundedString(
      proof.proofId,
      'continuity proof id',
      256
    );

    const nextTrustedTimeUs =
      previous.trustedTimeUs +
      proof.elapsedSinceAnchorUs;

    safeUnsigned(
      nextTrustedTimeUs,
      'proved trusted time'
    );

    return {
      ok: true,
      proofId: proof.proofId,
      nextTrustedTimeUs
    };
  } catch {
    return {
      ok: false,
      reasonCode: 'TRUSTED_TIME_PROOF_INVALID'
    };
  }
}

class TrustedOrganismTime {
  constructor({
    stateStore,
    organismId,
    bootIdProvider = defaultBootId,
    monotonicNowUs = defaultMonotonicNowUs,
    continuityProofVerifier = null
  }) {
    if (
      !stateStore ||
      typeof stateStore.readLife !== 'function' ||
      typeof stateStore.writeLife !== 'function'
    ) {
      fail(
        'StateStore is required',
        'TRUSTED_TIME_STATESTORE_REQUIRED'
      );
    }

    boundedString(organismId, 'organism id');

    if (
      typeof bootIdProvider !== 'function' ||
      typeof monotonicNowUs !== 'function'
    ) {
      fail(
        'trusted time providers are invalid',
        'TRUSTED_TIME_PROVIDER_INVALID'
      );
    }

    if (
      continuityProofVerifier !== null &&
      typeof continuityProofVerifier !== 'function'
    ) {
      fail(
        'continuity proof verifier is invalid',
        'TRUSTED_TIME_PROVIDER_INVALID'
      );
    }

    this.stateStore = stateStore;
    this.organismId = organismId;
    this.bootIdProvider = bootIdProvider;
    this.monotonicNowUs = monotonicNowUs;

    /*
     * Proof material cannot self-authorize.
     *
     * The verifier belongs to the trusted Kernel integration
     * boundary and will later bind continuity evidence to an
     * authenticated host/migration proof.
     */
    this.continuityProofVerifier =
      continuityProofVerifier;

    this.state = null;
    this.started = false;
  }

  readBootId() {
    return boundedString(
      this.bootIdProvider(),
      'boot id',
      128
    );
  }

  readMonotonicUs() {
    return safeUnsigned(
      this.monotonicNowUs(),
      'monotonic time'
    );
  }

  snapshot() {
    if (!this.state) {
      fail(
        'trusted organism time is not started',
        'TRUSTED_TIME_NOT_STARTED'
      );
    }

    return Object.freeze({ ...this.state });
  }

  async persist() {
    await this.stateStore.writeLife(
      STATE_KEY,
      this.state
    );

    return this.snapshot();
  }

  async becomeUncertain(
    reasonCode,
    currentBootId
  ) {
    this.state = {
      ...this.state,
      status: STATUS.UNCERTAIN,
      reasonCode,
      observedBootId: currentBootId,
      anchorMonotonicUs: null
    };

    return this.persist();
  }

  async acceptContinuityProof(
    previous,
    currentBootId,
    currentMonotonicUs,
    proof
  ) {
    const inspected =
      inspectContinuityProof(
        proof,
        {
          organismId: this.organismId,
          previous,
          currentBootId
        }
      );

    if (!inspected.ok) {
      this.state = previous;

      return this.becomeUncertain(
        inspected.reasonCode,
        currentBootId
      );
    }

    /*
     * A structurally valid proof is still only evidence.
     * It cannot declare itself trusted.
     *
     * Authority to bridge a whole-host continuity gap belongs
     * outside the proof object at the Kernel trust boundary.
     */
    let verified = false;

    try {
      if (
        typeof this.continuityProofVerifier === 'function'
      ) {
        verified =
          await this.continuityProofVerifier(
            proof,
            Object.freeze({
              organismId: this.organismId,
              fromBootId: previous.bootId,
              toBootId: currentBootId,
              anchorTrustedTimeUs:
                previous.trustedTimeUs,
              continuityEpoch:
                previous.continuityEpoch
            })
          ) === true;
      }
    } catch {
      verified = false;
    }

    if (!verified) {
      this.state = previous;

      return this.becomeUncertain(
        'TRUSTED_TIME_PROOF_UNVERIFIED',
        currentBootId
      );
    }

    this.state = {
      protocol: STATE_PROTOCOL,
      organismId: this.organismId,
      trustedTimeUs: inspected.nextTrustedTimeUs,
      continuityEpoch: previous.continuityEpoch + 1,
      status: STATUS.TRUSTED,
      reasonCode: null,
      bootId: currentBootId,
      observedBootId: currentBootId,
      anchorMonotonicUs: currentMonotonicUs,
      lastProofId: inspected.proofId
    };

    return this.persist();
  }

  async start({
    bootstrap = null,
    continuityProof = null
  } = {}) {
    if (this.started) {
      return this.sample();
    }

    const currentBootId =
      this.readBootId();

    const currentMonotonicUs =
      this.readMonotonicUs();

    const raw =
      await this.stateStore.readLife(
        STATE_KEY,
        null
      );

    if (!raw) {
      const seed =
        validateBootstrap(
          bootstrap,
          this.organismId
        );

      this.state = {
        protocol: STATE_PROTOCOL,
        organismId: this.organismId,
        trustedTimeUs: seed.trustedTimeUs,
        continuityEpoch: 1,
        status: STATUS.TRUSTED,
        reasonCode: null,
        bootId: currentBootId,
        observedBootId: currentBootId,
        anchorMonotonicUs: currentMonotonicUs,
        lastProofId: seed.proofId
      };

      this.started = true;
      return this.persist();
    }

    const previous =
      validateState(raw);

    if (
      previous.organismId !==
      this.organismId
    ) {
      fail(
        'trusted organism time belongs to another organism',
        'TRUSTED_TIME_ORGANISM_MISMATCH'
      );
    }

    this.state = previous;
    this.started = true;

    if (
      previous.status ===
      STATUS.UNCERTAIN
    ) {
      if (continuityProof) {
        return this.acceptContinuityProof(
          previous,
          currentBootId,
          currentMonotonicUs,
          continuityProof
        );
      }

      this.state = {
        ...previous,
        observedBootId: currentBootId
      };

      return this.persist();
    }

    if (
      currentBootId ===
      previous.bootId
    ) {
      if (
        currentMonotonicUs <
        previous.anchorMonotonicUs
      ) {
        return this.becomeUncertain(
          'TRUSTED_TIME_MONOTONIC_REWIND',
          currentBootId
        );
      }

      const elapsed =
        currentMonotonicUs -
        previous.anchorMonotonicUs;

      const nextTrustedTimeUs =
        previous.trustedTimeUs +
        elapsed;

      safeUnsigned(
        nextTrustedTimeUs,
        'recovered trusted time'
      );

      this.state = {
        ...previous,
        trustedTimeUs: nextTrustedTimeUs,
        observedBootId: currentBootId,
        anchorMonotonicUs: currentMonotonicUs,
        reasonCode: null
      };

      return this.persist();
    }

    return this.acceptContinuityProof(
      previous,
      currentBootId,
      currentMonotonicUs,
      continuityProof
    );
  }

  async sample() {
    if (!this.started) {
      fail(
        'trusted organism time is not started',
        'TRUSTED_TIME_NOT_STARTED'
      );
    }

    if (
      this.state.status !==
      STATUS.TRUSTED
    ) {
      return this.snapshot();
    }

    const currentBootId =
      this.readBootId();

    if (
      currentBootId !==
      this.state.bootId
    ) {
      return this.becomeUncertain(
        'TRUSTED_TIME_CONTINUITY_UNPROVEN',
        currentBootId
      );
    }

    const currentMonotonicUs =
      this.readMonotonicUs();

    if (
      currentMonotonicUs <
      this.state.anchorMonotonicUs
    ) {
      return this.becomeUncertain(
        'TRUSTED_TIME_MONOTONIC_REWIND',
        currentBootId
      );
    }

    const projected =
      this.state.trustedTimeUs +
      (
        currentMonotonicUs -
        this.state.anchorMonotonicUs
      );

    safeUnsigned(
      projected,
      'projected trusted time'
    );

    return Object.freeze({
      ...this.state,
      trustedTimeUs: projected,
      observedBootId: currentBootId
    });
  }

  async checkpoint() {
    const sampled =
      await this.sample();

    if (
      sampled.status !==
      STATUS.TRUSTED
    ) {
      return this.persist();
    }

    const currentBootId =
      this.readBootId();

    const currentMonotonicUs =
      this.readMonotonicUs();

    if (
      currentBootId !==
      this.state.bootId
    ) {
      return this.becomeUncertain(
        'TRUSTED_TIME_CONTINUITY_UNPROVEN',
        currentBootId
      );
    }

    if (
      currentMonotonicUs <
      this.state.anchorMonotonicUs
    ) {
      return this.becomeUncertain(
        'TRUSTED_TIME_MONOTONIC_REWIND',
        currentBootId
      );
    }

    const nextTrustedTimeUs =
      this.state.trustedTimeUs +
      (
        currentMonotonicUs -
        this.state.anchorMonotonicUs
      );

    safeUnsigned(
      nextTrustedTimeUs,
      'checkpoint trusted time'
    );

    this.state = {
      ...this.state,
      trustedTimeUs: nextTrustedTimeUs,
      observedBootId: currentBootId,
      anchorMonotonicUs: currentMonotonicUs,
      status: STATUS.TRUSTED,
      reasonCode: null
    };

    return this.persist();
  }
}

module.exports = {
  TrustedOrganismTime,
  STATUS,
  STATE_KEY,
  STATE_PROTOCOL,
  BOOTSTRAP_PROTOCOL,
  CONTINUITY_PROOF_PROTOCOL
};
