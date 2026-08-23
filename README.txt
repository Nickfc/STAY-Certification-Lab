STAY 0.8.11.3 - HOSTILE-AUDIT REPAIR CANDIDATE - PRE-CERTIFICATION

This is the GitHub-ready source handoff. It implements the v0.8 code and automated
fault gates, but it is not a claim that the required real 24-hour and 72-hour mixed-node
endurance certification has already passed.

Run:
  npm test
  npm run test:continuity
  npm run test:faults
  npm run test:smoke

Do not include /var/lib/stay/data, .stay-data, operator tokens, live brain state or
other production state in Git.

The fetus compatibility wrapper and 0.6 fingerprints are unchanged from 0.7.1.12.
