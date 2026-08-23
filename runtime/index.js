'use strict';

const path = require('node:path');
const { LivingKernel: HardenedLivingKernel } = require('./kernel/hardened-living-kernel');

const MAX_AUXILIARY_CORES = 16;

function configurationError(message, code) {
  return Object.assign(new Error(message), { code });
}

function parseAuxiliaryCorePaths(value, { cwd = process.cwd() } = {}) {
  if (value == null || value === '') return Object.freeze([]);

  const entries = Array.isArray(value) ? [...value] : String(value).split(',');
  if (entries.length > MAX_AUXILIARY_CORES) {
    throw configurationError(
      `too many auxiliary boot cores: ${entries.length} > ${MAX_AUXILIARY_CORES}`,
      'AUXILIARY_CORE_LIMIT'
    );
  }

  const resolved = [];
  const seen = new Set();
  for (const raw of entries) {
    const text = String(raw).trim();
    if (!text) {
      throw configurationError('auxiliary boot core path is empty', 'AUXILIARY_CORE_PATH_EMPTY');
    }
    const absolute = path.resolve(cwd, text);
    if (seen.has(absolute)) {
      throw configurationError(`duplicate auxiliary boot core: ${absolute}`, 'AUXILIARY_CORE_DUPLICATE');
    }
    seen.add(absolute);
    resolved.push(absolute);
  }

  return Object.freeze(resolved);
}

function normalizePrimaryBootCorePath(value, cwd = process.cwd()) {
  if (value == null || String(value).trim() === '') return null;
  return path.resolve(cwd, String(value).trim());
}

function assertPrimaryIsNotAuxiliary(primaryPath, auxiliaryCorePaths) {
  if (!primaryPath) return;
  if (auxiliaryCorePaths.includes(primaryPath)) {
    throw configurationError(
      `primary boot core is also configured as auxiliary: ${primaryPath}`,
      'AUXILIARY_CORE_PRIMARY_DUPLICATE'
    );
  }
}

async function installAuxiliaryCores({ auxiliaryCorePaths, primaryPath = null, install }) {
  if (typeof install !== 'function') {
    throw configurationError('auxiliary core installer is unavailable', 'AUXILIARY_CORE_INSTALLER_INVALID');
  }
  assertPrimaryIsNotAuxiliary(primaryPath, auxiliaryCorePaths);

  const installed = [];
  for (const modulePath of auxiliaryCorePaths) {
    installed.push(await install(modulePath));
  }
  return Object.freeze(installed);
}

async function installPrimaryAndAuxiliary({ primaryPath, auxiliaryCorePaths, install }) {
  if (typeof install !== 'function') {
    throw configurationError('boot core installer is unavailable', 'AUXILIARY_CORE_INSTALLER_INVALID');
  }
  const resolvedPrimary = path.resolve(primaryPath);
  assertPrimaryIsNotAuxiliary(resolvedPrimary, auxiliaryCorePaths);

  const primaryUnit = await install(resolvedPrimary);
  const auxiliaryUnits = await installAuxiliaryCores({
    auxiliaryCorePaths,
    primaryPath: resolvedPrimary,
    install
  });
  return Object.freeze({ primaryUnit, auxiliaryUnits });
}

class LivingKernel extends HardenedLivingKernel {
  constructor(options = {}) {
    const {
      auxiliaryCorePaths = process.env.STAY_AUX_CORES || '',
      auxiliaryCoreCwd = process.cwd(),
      primaryBootCorePath = process.env.STAY_BOOT_CORE || '',
      ...kernelOptions
    } = options;
    super(kernelOptions);

    this.auxiliaryCorePaths = parseAuxiliaryCorePaths(auxiliaryCorePaths, { cwd: auxiliaryCoreCwd });
    this.primaryBootCorePath = normalizePrimaryBootCorePath(primaryBootCorePath, auxiliaryCoreCwd);
    assertPrimaryIsNotAuxiliary(this.primaryBootCorePath, this.auxiliaryCorePaths);
    this.auxiliaryBootComplete = false;
    this.auxiliaryBootUnits = Object.freeze([]);
  }

  async start() {
    await super.start();
    if (!this.primaryBootCorePath) await this.installAuxiliaryBootCores();
    return this;
  }

  async installCore(modulePath) {
    const primaryPath = path.resolve(modulePath);
    if (!this.auxiliaryBootComplete && this.auxiliaryCorePaths.length > 0 && this.primaryBootCorePath && primaryPath !== this.primaryBootCorePath) {
      throw configurationError(
        `boot core differs from STAY_BOOT_CORE while auxiliary cores are pending: ${primaryPath}`,
        'AUXILIARY_CORE_PRIMARY_MISMATCH'
      );
    }
    if (this.auxiliaryBootComplete || this.auxiliaryCorePaths.length === 0) {
      return super.installCore(primaryPath);
    }

    const result = await installPrimaryAndAuxiliary({
      primaryPath,
      auxiliaryCorePaths: this.auxiliaryCorePaths,
      install: corePath => super.installCore(corePath)
    });
    this.auxiliaryBootUnits = result.auxiliaryUnits;
    this.auxiliaryBootComplete = true;
    return result.primaryUnit;
  }

  async installAuxiliaryBootCores() {
    if (this.auxiliaryBootComplete) return this.auxiliaryBootUnits;
    const units = await installAuxiliaryCores({
      auxiliaryCorePaths: this.auxiliaryCorePaths,
      primaryPath: this.primaryBootCorePath,
      install: corePath => super.installCore(corePath)
    });
    this.auxiliaryBootUnits = units;
    this.auxiliaryBootComplete = true;
    return units;
  }
}

module.exports = {
  LivingKernel,
  MAX_AUXILIARY_CORES,
  parseAuxiliaryCorePaths,
  installAuxiliaryCores,
  installPrimaryAndAuxiliary
};
