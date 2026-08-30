'use strict';

const ROUTE_STAGE = 'ABSENT';

const routes = [
  ['p1r0.capacity.metab', 'KERNEL_RESOURCE', 'METAB', 'resource.capacity.eligible.v1', 'SUMMARY'],
  ['p1r0.capacity-quality.metab', 'KERNEL_RESOURCE', 'METAB', 'resource.capacity.quality.v1', 'INTEGRITY'],
  ['p1r0.metab-availability.homeos', 'METAB', 'HOMEOS', 'metab.energy.availability.v1', 'SUMMARY'],
  ['p1r0.metab-reserve.homeos', 'METAB', 'HOMEOS', 'metab.energy.reserve.v1', 'SUMMARY'],
  ['p1r0.metab-availability.intero', 'METAB', 'INTERO', 'metab.energy.availability.v1', 'SUMMARY'],
  ['p1r0.metab-reserve.intero', 'METAB', 'INTERO', 'metab.energy.reserve.v1', 'SUMMARY'],
  ['p1r0.homeos-dimension.intero', 'HOMEOS', 'INTERO', 'homeos.dimension.summary.v1', 'SUMMARY'],
  ['p1r0.homeos-stability.intero', 'HOMEOS', 'INTERO', 'homeos.stability.summary.v1', 'SUMMARY'],
  ['p1r0.intero.sntss-receptor', 'INTERO', 'SNTSS_RECEPTOR_P1_R0', 'intero.body.frame.v1', 'SUMMARY']
].map(([routeId, producer, consumer, topic, topicClass]) => Object.freeze({
  routeId,
  producer,
  consumer,
  topic,
  topicClass,
  minDelayFrames: 1,
  revocable: true,
  requirement: consumer === 'SNTSS_RECEPTOR_P1_R0' ? 'GATED' : 'REQUIRED',
  stage: ROUTE_STAGE
}));

const ROUTES = Object.freeze(Object.fromEntries(routes.map(route => [route.routeId, route])));
const FORBIDDEN_EDGES = Object.freeze([
  'INTERO->HOMEOS',
  'SNTSS->METAB',
  'SNTSS->HOMEOS',
  'SNTSS->INTERO',
  'HOMEOS->CARD',
  'HOMEOS->RESP'
]);
const FORBIDDEN_EDGE_SET = new Set(FORBIDDEN_EDGES);

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

function core(value) {
  return String(value || '').trim().toUpperCase().replaceAll('-', '_');
}

function routeFor(routeId) {
  const route = ROUTES[routeId];
  if (!route) fail('P1-R0 route is not registered', 'P1_ROUTE_UNKNOWN');
  return route;
}

function validateFrameRoute(frame) {
  const route = routeFor(frame.route.routeId);
  const producer = core(frame.producer.coreId);
  const consumer = core(frame.route.consumerCoreId);
  if (FORBIDDEN_EDGE_SET.has(`${producer}->${consumer}`)) {
    fail('P1-R0 edge is constitutionally forbidden', 'P1_ROUTE_FORBIDDEN');
  }
  if (
    route.producer !== producer ||
    route.consumer !== consumer ||
    route.topic !== frame.topic.name ||
    route.topicClass !== frame.topic.class
  ) {
    fail('P1-R0 frame does not match its closed route declaration', 'P1_ROUTE_MISMATCH');
  }
  if (frame.visibleFromFrame < frame.committedFrame + route.minDelayFrames) {
    fail('P1-R0 route delay is not satisfied', 'P1_ROUTE_DELAY');
  }
  return route;
}

module.exports = Object.freeze({
  ROUTE_STAGE,
  ROUTES,
  FORBIDDEN_EDGES,
  routeFor,
  validateFrameRoute
});
