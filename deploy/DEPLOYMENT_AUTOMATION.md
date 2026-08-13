# STAY deployment automation

## Why this exists

The first 0.7 production awakenings were deliberately performed as explicit manual steps so every continuity invariant could be observed. GitHub Actions was then disabled because automatic push-triggered failures generated too much email.

That is not the intended steady-state workflow.

## After this deployer is installed

### Safe archive workflow (works immediately)

1. Build once on Windows:
   `powershell -ExecutionPolicy Bypass -File tools\build-release.ps1`
2. Upload the one generated `.tar.gz` with WinSCP.
3. Run one command:
   `sudo stay-deploy /home/ubuntu/<archive>`

`stay-deploy` automatically performs:

- archive validation
- version/filename validation
- JavaScript syntax checks
- isolated Living Runtime continuity test
- immutable release installation
- clean service stop
- complete state safety backup
- atomic `/opt/stay/current` switch
- service restart
- health/version validation
- organism identity continuity validation
- real Nginx `GET /` test
- browser surface tests
- proof that the legacy brain resumes persistence
- automatic rollback to the prior release if any acceptance step fails

## Push -> one command workflow

Because the GitHub repository is private, Lightsail needs a **read-only GitHub deploy key** once.

### One-time setup

Create a key as `staydeploy`:

`sudo -u staydeploy ssh-keygen -t ed25519 -f /home/staydeploy/.ssh/stay-github-readonly -N '' -C 'stay-genesis-lightsail-readonly'`

Show the public half:

`sudo cat /home/staydeploy/.ssh/stay-github-readonly.pub`

In GitHub:
Repository -> Settings -> Deploy keys -> Add deploy key

- Title: `STAY Lightsail read-only`
- Paste the public key
- **Do NOT enable write access**

Then prepare SSH and source clone:

`sudo -u staydeploy ssh-keyscan -H github.com | sudo tee -a /home/staydeploy/.ssh/known_hosts >/dev/null`

`sudo chown staydeploy:staydeploy /home/staydeploy/.ssh/known_hosts`

`sudo chmod 600 /home/staydeploy/.ssh/known_hosts`

`sudo mkdir -p /opt/stay/source`

`sudo chown staydeploy:staydeploy /opt/stay/source`

`sudo -u staydeploy env GIT_SSH_COMMAND="ssh -i /home/staydeploy/.ssh/stay-github-readonly -o IdentitiesOnly=yes" git clone --branch agent/living-runtime-0.7.0 git@github.com:Nickfc/STAY-Genesis.git /opt/stay/source`

Persist the read-only key for that clone:

`sudo -u staydeploy git -C /opt/stay/source config core.sshCommand "ssh -i /home/staydeploy/.ssh/stay-github-readonly -o IdentitiesOnly=yes"`

### Every normal release after that

Push the commit to GitHub, then on Lightsail:

`sudo stay-deploy-git`

That command fetches the branch, builds the exact immutable archive on Lightsail, invokes `stay-deploy`, validates the upgrade and rolls back automatically on failure.

You can also deploy an exact pushed commit:

`sudo stay-deploy-git <40-character-commit-sha>`

## Scope

This automation is for normal STAY release/core/UI changes that use the existing service contract. Changes to systemd policy, Nginx architecture, firewalling, Node installation or other host infrastructure should still be reviewed explicitly rather than silently applied.
