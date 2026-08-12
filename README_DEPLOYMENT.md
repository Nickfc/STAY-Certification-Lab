# STAY deployment foundation

Production runtime layout:

- `/opt/stay/releases/` — immutable application releases
- `/opt/stay/current` — symlink to active release
- `/var/lib/stay/data/` — persistent organism state
- `/etc/stay/` — production configuration/secrets
- `/var/backups/stay/` — state backups

Runtime state and operator credentials must never be committed to this repository.
