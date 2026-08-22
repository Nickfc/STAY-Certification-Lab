# Legacy 0.6.0 certification fixture

This directory is reserved for the encrypted canonical non-live certification fixture:

`source.tar.gz.gpg`

Only the encrypted GPG ciphertext may be committed here. The plaintext `source.tar.gz` and extracted fixture files must never be committed to this public repository.

The private STAY-Genesis certification harness verifies the decrypted archive against its committed canonical archive SHA-256 and the sealed per-file inventory before use. Decryption and extraction occur only inside the ephemeral GitHub Actions runner and are destroyed on success or failure.
