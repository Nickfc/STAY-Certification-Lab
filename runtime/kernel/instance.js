'use strict';

class RuntimeUnit {
  constructor(definition, api, mode) {
    this.definition = definition;
    this.manifest = definition.manifest;
    this.api = api;
    this.mode = mode;
    this.handledEvents = 0;
  }

  setMode(mode) { this.mode = mode; }
  async handle(event) { await this.api.handle(event); this.handledEvents += 1; }
  async snapshot() { return this.api.snapshot(); }
  async health() { return this.api.health(); }
  async stop() { if (this.api.stop) await this.api.stop(); }
}

module.exports = { RuntimeUnit };
