STAY Chronobiology C3-C server certification candidate
=======================================================

NOTE: The split-host contract in SPLIT_HOST_README.txt now governs final-candidate
acceptance. This combined actual-host runner remains a diagnostic and cannot by
itself satisfy the final C3-C seal gate.

This bundle certifies the exact GitHub-visible feature/chronobiology HEAD in the
proper server environment. It never deploys, restarts stay.service, switches
/opt/stay/current, mutates live StateStore, merges main, or enables authority.

RUN.sh fails closed unless:

  * the repository is clean and on feature/chronobiology;
  * local HEAD equals origin/feature/chronobiology;
  * the Chronobiology package-policy identity matches the final candidate;
  * /opt/stay/legacy/0.6.0 is present;
  * Unix-domain sockets work in the certification environment;
  * all direct, targeted, and complete repository tests have zero failures,
    skips, todos, or cancellations;
  * no new Node process remains after the suites;
  * stay.service and /opt/stay/current sentinels are byte-identical before and
    after certification; and
  * the repository stays clean and at the same commit.

Evidence is written outside the repository at:

  /var/tmp/stay-chronobiology-c3c

The success result is CANDIDATE_CERTIFIED_UNSEALED. It is not a final C3-C seal.
The evidence must be reviewed and bound in a separate, explicit seal checkpoint.
