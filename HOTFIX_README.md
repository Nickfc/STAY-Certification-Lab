# STAY 0.8.11.3 deployment bootstrap hotfix

Upload the two included files to the existing `agent/living-runtime-0.7.0` branch at these exact repository paths:

- `deploy/stay-deploy-git.sh`
- `test/hostile-closure.test.js`

This correction makes `/opt/stay/incoming` and the temporary archive-build directory writable only by `staydeploy` before the script deliberately drops privileges for `git archive` and extraction. The regression test requires that ownership transition to occur before the unprivileged archive command.

After GitHub reports 40 passed and 0 failed, use the new full 40-character commit SHA for the server bootstrap and deployment. Do not deploy commit `10e5072824b66e8c0baf54c049d36620364056fd`; it predates this hotfix.
