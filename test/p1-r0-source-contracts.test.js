'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'runtime', 'p1-r0', 'c0-source-contracts');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

test('P1R0-C0-01 reviewed source contracts retain their immutable pack hashes', () => {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(source, {
    archive: 'STAY_P1_R0_Laboratory_Implementation_Pack_C0_v1.0.zip',
    archiveSha256: '3a4ed9516a9e22dd2dadd4238072d0afc95bfde7d8e1d1e33e85f4426b67115e',
    manifestSha256: 'b095c882407ec3d9f2c416309711e6519b41e2fb4fbf2f89f533cab952dc6d69',
    selectedFiles: 14,
    selection: 'Reviewed common schemas and registries required by P1-R0 foundations',
    sourceOnly: true
  });
  const lines = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(lines.length, source.selectedFiles);
  const declared = new Set();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_.\/-]+)$/.exec(line);
    assert.ok(match, line);
    const [, expected, relative] = match;
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.split('/').includes('..'), false);
    assert.equal(declared.has(relative), false);
    declared.add(relative);
    assert.equal(sha256(fs.readFileSync(path.join(root, ...relative.split('/')))), expected, relative);
  }
  const actual = [];
  for (const family of ['contracts', 'schemas']) {
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else actual.push(path.relative(root, absolute).replaceAll('\\', '/'));
      }
    };
    visit(path.join(root, family));
  }
  assert.deepEqual(actual.sort(), [...declared].sort());
});

test('P1R0-C0-02 selected common schema identifiers and references are closed', () => {
  const schemaRoot = path.join(root, 'schemas', 'common');
  const schemas = fs.readdirSync(schemaRoot).sort().map(name => JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8')));
  assert.equal(schemas.length, 8);
  const ids = new Set(schemas.map(schema => schema.$id));
  assert.equal(ids.size, schemas.length);
  for (const schema of schemas) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    if (schema.type === 'object') assert.equal(schema.additionalProperties, false);
    else assert.equal(schema.type, 'string');
    walk(schema, value => {
      if (typeof value.$ref === 'string' && value.$ref.startsWith('urn:stay:p1-r0:schema:')) {
        assert.equal(ids.has(value.$ref), true, `${schema.$id} -> ${value.$ref}`);
      }
    });
  }
});

test('P1R0-C0-03 source route and topic registries remain absent, revocable and closed', () => {
  const routes = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'route_registry.json'), 'utf8'));
  const topics = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'topic_registry.json'), 'utf8'));
  assert.equal(routes.initialMode, 'ABSENT');
  assert.equal(routes.routes.length, 9);
  const topicNames = new Set(topics.topics.map(topic => topic.topic));
  const routeIds = new Set();
  for (const route of routes.routes) {
    assert.equal(routeIds.has(route.routeId), false);
    routeIds.add(route.routeId);
    assert.equal(route.revocable, true);
    assert.equal(route.minDelayFrames, 1);
    assert.equal(topicNames.has(route.topic), true);
  }
  assert.equal(routes.routes.filter(route => route.requirement === 'GATED').length, 1);
  assert.equal(routes.routes.find(route => route.requirement === 'GATED').consumer, 'SNTSS_RECEPTOR_P1_R0');
  for (const disabled of topics.reservedDisabled) {
    assert.equal(routes.routes.some(route => disabled.includes(route.topic)), false);
  }
});

test('P1R0-C0-04 ownership registry contains the INTERO semantic prohibitions', () => {
  const ownership = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'ownership_registry.json'), 'utf8'));
  assert.deepEqual(ownership.nonOwners.INTERO, ['source truth', 'emotion', 'cause', 'self', 'action']);
  assert.deepEqual(ownership.nonOwners.CHIP_UI, ['all biological and authority state']);
  assert.equal(ownership.owners.METAB.includes('energy reserve'), true);
  assert.equal(ownership.owners.HOMEOS.includes('target-independent pressure'), true);
});
