'use strict';

// Production native cores execute behind the trusted two-process supervisor.
// Laboratory/legacy tests retain the previously certified direct CoreHost path;
// production sets STAY_REQUIRE_OS_CORE_SANDBOX=1 in systemd and cannot fall back.
if (process.env.STAY_REQUIRE_OS_CORE_SANDBOX === '1') {
  require('./sandbox-host');
} else {
  require('./host-legacy');
}
