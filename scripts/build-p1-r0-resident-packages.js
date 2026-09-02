'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('../runtime/kernel/canonical-json');

const ROOT = path.resolve(__dirname, '..');
const DEFINITIONS = Object.freeze({
  METAB_NEUTRAL: Object.freeze({
    entry: 'runtime/p1-r0/residents/metab-neutral.js',
    output: 'cores/p1-r0/metab-neutral',
    leaf: 'p1-r0-metab-<instance>',
    policyCoreId: 'METAB'
  }),
  METAB: Object.freeze({
    entry: 'runtime/p1-r0/residents/metab.js',
    output: 'cores/p1-r0/metab',
    leaf: 'p1-r0-metab-<instance>'
  }),
  HOMEOS: Object.freeze({
    entry: 'runtime/p1-r0/residents/homeos.js',
    output: 'cores/p1-r0/homeos',
    leaf: 'p1-r0-homeos-<instance>'
  }),
  INTERO: Object.freeze({
    entry: 'runtime/p1-r0/residents/intero.js',
    output: 'cores/p1-r0/intero',
    leaf: 'p1-r0-intero-<instance>'
  })
});

const MANIFEST_RESOURCES = Object.freeze({
  softRamMiB: 64,
  hardRamMiB: 96,
  softCpuPercent: 5,
  hardCpuPercent: 20,
  pidsMax: 16,
  queueCapacity: 256,
  handlerTimeoutMs: 250,
  healthTimeoutMs: 1000,
  outputCapacity: 128,
  outputLimitPerEvent: 16,
  outputBytesPerEvent: 65536,
  storageMiB: 4,
  maxRestarts: 4,
  restartWindowMs: 60000,
  restartBackoffMs: 250
});

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function relativeId(absolute, root = ROOT) {
  return path.relative(root, absolute).replaceAll('\\', '/');
}

function resolveLocal(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
  throw new Error(`cannot resolve P1-R0 package dependency ${request} from ${parent}`);
}

function bundle(entryRelative, root = ROOT) {
  const modules = new Map();
  const builtins = new Set();

  function visit(absolute) {
    const id = relativeId(absolute, root);
    if (modules.has(id)) return id;
    const extension = path.extname(absolute);
    if (extension === '.json') {
      const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      modules.set(id, `module.exports = ${stableStringify(parsed)};`);
      return id;
    }
    if (extension !== '.js') throw new Error(`unsupported bundled dependency: ${id}`);
    let source = fs.readFileSync(absolute, 'utf8').replaceAll('\r\n', '\n');
    const requests = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)]
      .map(match => match[2]);
    const replacements = new Map();
    for (const request of requests) {
      if (request.startsWith('.')) {
        const target = resolveLocal(absolute, request);
        replacements.set(request, visit(target));
      } else {
        if (!request.startsWith('node:')) throw new Error(`external dependency is forbidden: ${request}`);
        builtins.add(request);
      }
    }
    source = source.replace(
      /\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
      (_match, _quote, request) => `__bundleRequire(${JSON.stringify(replacements.get(request))})`
    );
    modules.set(id, source.trimEnd());
    return id;
  }

  const entry = visit(path.resolve(root, entryRelative));
  const inventory = [...modules.keys()].sort();
  const sourceSeal = digest(stableStringify(
    Object.fromEntries(inventory.map(id => [id, digest(modules.get(id))]))
  ));
  const definitions = inventory.map(id =>
    `${JSON.stringify(id)}: function(module, exports, __bundleRequire) {\n${modules.get(id)}\n}`
  ).join(',\n');
  const output = `'use strict';\n\n` +
    `// Deterministic P1-R0 resident bundle. Source seal: ${sourceSeal}\n` +
    `const __bundleModules = {\n${definitions}\n};\n` +
    `const __bundleCache = new Map();\n` +
    `function __bundleRequire(id) {\n` +
    `  if (__bundleCache.has(id)) return __bundleCache.get(id).exports;\n` +
    `  const factory = __bundleModules[id];\n` +
    `  if (!factory) throw new Error('unknown bundled P1-R0 module: ' + id);\n` +
    `  const module = { exports: {} };\n` +
    `  __bundleCache.set(id, module);\n` +
    `  factory(module, module.exports, __bundleRequire);\n` +
    `  return module.exports;\n` +
    `}\n` +
    `module.exports = __bundleRequire(${JSON.stringify(entry)});\n`;
  return Object.freeze({ output, builtins: Object.freeze([...builtins].sort()), inventory, sourceSeal });
}

function policy(coreId, definition, bundleRecord) {
  const body = {
    formatVersion: 1,
    coreId,
    entrypoint: 'index.js',
    allowedBuiltins: [...bundleRecord.builtins],
    ambientCapabilities: {
      filesystemWrite: false,
      network: false,
      processSpawn: false
    },
    diagnostics: false,
    environmentAllowlist: ['LANG', 'LC_ALL', 'NODE_ENV', 'PATH', 'STAY_COREHOST', 'TZ'],
    files: {
      'index.js': digest(bundleRecord.output)
    },
    resourceContract: {
      cgroupV2: {
        distribution: 'stay-cores',
        leaf: definition.leaf,
        controllers: ['cpu', 'memory', 'pids'],
        kernelGovernorOwned: true,
        memoryHighBytes: 67_108_864,
        memoryMaxBytes: 100_663_296,
        pidsMax: 16,
        cpuMax: '20000 100000'
      },
      manifestResources: { ...MANIFEST_RESOURCES },
      requiredOnProductionHost: true
    },
    bounds: {
      checkpointBytes: 1_048_576,
      auditRecords: 64,
      auditRecordBytes: 4096,
      migrationRecords: 64,
      migrationWorkItems: 1,
      shutdownMs: 2000,
      pendingRequests: 128,
      productionOutputs: 0
    }
  };
  return Object.freeze({ ...body, policyHash: digest(stableStringify(body)) });
}

function buildAll({ root = ROOT } = {}) {
  const hashes = {};
  for (const [coreId, definition] of Object.entries(DEFINITIONS)) {
    const bundleRecord = bundle(definition.entry, root);
    const packagePolicy = policy(definition.policyCoreId || coreId, definition, bundleRecord);
    const outputRoot = path.resolve(root, definition.output);
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'index.js'), bundleRecord.output);
    fs.writeFileSync(path.join(outputRoot, 'package-policy.json'), `${JSON.stringify(packagePolicy, null, 2)}\n`);
    hashes[coreId] = packagePolicy.policyHash;
  }
  const hashPath = path.resolve(root, 'runtime/p1-r0/resident-package-hashes.json');
  fs.writeFileSync(hashPath, `${JSON.stringify(hashes, null, 2)}\n`);
  return Object.freeze(hashes);
}

if (require.main === module) {
  process.stdout.write(`${stableStringify(buildAll())}\n`);
}

module.exports = Object.freeze({ DEFINITIONS, MANIFEST_RESOURCES, bundle, buildAll, policy });
