STAY Chronobiology C3-C compute-only certification
==================================================

Authorized orchestration repository:

  Nickfc/STAY-Certification-Lab (private)

The source checkout must be Nickfc/STAY-Genesis at an exact detached commit.
The caller supplies the full 40-hex candidate SHA and a private absolute output
directory outside the checkout. GITHUB_REPOSITORY, or the explicit
--lab-repository argument, must equal Nickfc/STAY-Certification-Lab.

Invocation contract:

  bash certification/chronobiology-c3c/compute/RUN.sh \
    --candidate-sha "$CANDIDATE_SHA" \
    --output-root "$RUNNER_TEMP/stay-chronobiology-c3c" \
    --lab-repository Nickfc/STAY-Certification-Lab

Preconditions:

  * detached HEAD equals CANDIDATE_SHA and the worktree is clean;
  * /opt/stay/legacy/0.6.0 contains the sealed legacy fixture;
  * Node satisfies package.json and Unix-domain sockets work;
  * CPU steal is at most 5 percent during preflight and the complete run;
  * raw evidence storage is private and outside the source checkout.

The runner executes the Chronobiology direct suite, every targeted residency,
BSF, CoreHost, trusted-time and SNTSS regression, and the complete repository
suite. Every suite must report zero failures, skips, todos and cancellations.
The frozen 250 ms one-year catch-up gate is measured independently and is also
exercised by the direct containment suite.

Raw TAP, process inventories, source tree and environment captures remain under
<output-root>/raw with mode-0700/0600 permissions. They must be retained only as
a private artifact in Nickfc/STAY-Certification-Lab. The only cross-host artifact
is:

  <output-root>/COMPUTE_RESULT.sanitized.json

This runner does not inspect, create, emulate or modify stay.service,
/opt/stay/current, live StateStore or any live-organism sentinel.
