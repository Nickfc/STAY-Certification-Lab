#!/usr/bin/env python3
"""Build and verify the deterministic legacy-0.6 certification transport."""

import argparse
import gzip
import hashlib
import io
import json
import os
import pathlib
import shutil
import stat
import tarfile
import zipfile


PREFIX = "source/0.6.0/"
NORMALIZED_MTIME = 0


def fail(message):
    raise SystemExit(f"legacy fixture transport rejected: {message}")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_inventory(filename):
    with open(filename, "r", encoding="utf-8") as source:
        inventory = json.load(source)
    if not isinstance(inventory, dict) or len(inventory) != 8:
        fail("canonical SOURCE_FILES inventory is invalid")
    for relative, expected in inventory.items():
        pure = pathlib.PurePosixPath(relative)
        if (not relative or pure.is_absolute() or ".." in pure.parts
                or len(expected) != 64
                or any(character not in "0123456789abcdef" for character in expected)):
            fail("canonical SOURCE_FILES inventory is unsafe")
    return inventory


def safe_member(name):
    pure = pathlib.PurePosixPath(name)
    return bool(name) and not pure.is_absolute() and ".." not in pure.parts and "\0" not in name


def read_migration_source(filename, inventory):
    found = {}
    seen = set()
    with zipfile.ZipFile(filename, "r") as migration:
        for member in migration.infolist():
            name = member.filename
            if not safe_member(name) or name in seen:
                fail("migration ZIP contains an unsafe or duplicate path")
            seen.add(name)
            unix_mode = (member.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(unix_mode):
                fail("migration ZIP contains a symbolic link")
            if not name.startswith(PREFIX) or name == PREFIX:
                continue
            relative = name[len(PREFIX):]
            if member.is_dir():
                continue
            if relative not in inventory:
                # The migration bundle also carries historical documentation and
                # tests. They are migration content, not fixture material: never
                # read, extract, hash, or copy them into the transport.
                continue
            data = migration.read(member)
            if digest(data) != inventory[relative]:
                fail(f"SOURCE_FILES hash mismatch: {relative}")
            found[relative] = data
    if set(found) != set(inventory):
        fail("migration source tree is missing a SOURCE_FILES member")
    return found


def normalized_tar(files):
    buffer = io.BytesIO()
    directories = {"source", "source/0.6.0"}
    for relative in files:
        parent = pathlib.PurePosixPath(PREFIX + relative).parent
        while str(parent) not in (".", ""):
            directories.add(str(parent))
            parent = parent.parent
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for directory in sorted(directories):
            info = tarfile.TarInfo(f"{directory}/")
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = NORMALIZED_MTIME
            archive.addfile(info)
        for relative in sorted(files):
            data = files[relative]
            info = tarfile.TarInfo(PREFIX + relative)
            info.size = len(data)
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = NORMALIZED_MTIME
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def write_deterministic_archive(files, output):
    tar_bytes = normalized_tar(files)
    temporary = f"{output}.tmp.{os.getpid()}"
    try:
        with open(temporary, "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw,
                               compresslevel=9, mtime=NORMALIZED_MTIME) as compressed:
                compressed.write(tar_bytes)
        os.chmod(temporary, 0o600)
        os.replace(temporary, output)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    with open(output, "rb") as archive:
        return digest(archive.read())


def verify_archive(filename, inventory, output):
    expected_names = {PREFIX + relative for relative in inventory}
    found = {}
    with tarfile.open(filename, "r:gz") as archive:
        seen = set()
        for member in archive.getmembers():
            name = member.name.rstrip("/")
            if not safe_member(name) or name in seen:
                fail("decrypted archive contains an unsafe or duplicate path")
            seen.add(name)
            if member.issym() or member.islnk():
                fail("decrypted archive contains a link")
            if member.isdir():
                continue
            if not member.isfile() or name not in expected_names:
                fail("decrypted archive contains material outside SOURCE_FILES")
            stream = archive.extractfile(member)
            if stream is None:
                fail("decrypted archive member is unreadable")
            data = stream.read()
            relative = name[len(PREFIX):]
            if digest(data) != inventory[relative]:
                fail(f"decrypted SOURCE_FILES hash mismatch: {relative}")
            found[relative] = data
    if set(found) != set(inventory):
        fail("decrypted archive is missing a SOURCE_FILES member")

    destination = pathlib.Path(output)
    destination.mkdir(parents=True, mode=0o700)
    for relative in sorted(found):
        target = destination.joinpath(*pathlib.PurePosixPath(relative).parts)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(target, "xb") as fixture_file:
            fixture_file.write(found[relative])
        os.chmod(target, 0o444)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("mode", choices=("build", "verify-extract"))
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    inventory = load_inventory(args.inventory)
    if args.mode == "build":
        files = read_migration_source(args.input, inventory)
        print(write_deterministic_archive(files, args.output))
    else:
        verify_archive(args.input, inventory, args.output)


if __name__ == "__main__":
    main()
