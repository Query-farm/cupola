#!/usr/bin/env python3
"""R2 release verification, promotion, rollback, and conservative retention.

Invoked through releases.sh to load the same credentials as publish.sh.
AWS CLI handles pagination; credentials never appear in command arguments.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\Z")
BUCKET = "cupola-assets"


def aws(operation, **kwargs):
    command = ["aws", "s3api", operation, "--bucket", BUCKET,
               "--endpoint-url", f"https://{os.environ.get('CF_ACCOUNT_ID', 'bb68a133a66d26a310231495b13479a1')}.r2.cloudflarestorage.com",
               "--output", "json"]
    for key, value in kwargs.items():
        command.extend(["--" + key.replace("_", "-"), str(value)])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout or "{}")


def objects(prefix=""):
    return aws("list-objects-v2", prefix=prefix).get("Contents", [])


def read(key):
    with tempfile.NamedTemporaryFile() as file:
        # get-object takes its output file as a positional argument.
        command = ["aws", "s3api", "get-object", "--bucket", BUCKET, "--key", key,
                   "--endpoint-url", f"https://{os.environ.get('CF_ACCOUNT_ID', 'bb68a133a66d26a310231495b13479a1')}.r2.cloudflarestorage.com", file.name]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        return Path(file.name).read_text(), json.loads(result.stdout)["ETag"]


def put(key, body, **conditions):
    with tempfile.NamedTemporaryFile() as file:
        Path(file.name).write_text(body)
        return aws("put-object", key=key, body=file.name, content_type="application/json" if key.endswith(".json") else "text/plain",
                   cache_control="no-store", **conditions)


def now():
    return datetime.now(timezone.utc)


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def cleanup_plan(items, current, clock):
    releases = {}
    for item in items:
        prefix, _, filename = item["Key"].partition("/")
        if not prefix.startswith("v") or not VERSION.fullmatch(prefix[1:]) or not filename:
            continue
        release = releases.setdefault(prefix[1:], {"newest": timestamp(item["LastModified"]), "index": False, "reserved": False, "verified": False, "keys": []})
        release["newest"] = max(release["newest"], timestamp(item["LastModified"]))
        release["index"] |= filename == "index.html"
        release["reserved"] |= filename == "_upload.json"
        release["verified"] |= filename == "_release.json"
        release["keys"].append(item["Key"])
    ordered = sorted((v for v in releases if releases[v]["index"] and (releases[v]["verified"] or not releases[v]["reserved"]) and v != current), key=lambda v: releases[v]["newest"], reverse=True)
    protected = {current, *ordered[:2]}
    return {v: data["keys"] for v, data in releases.items()
            if v not in protected and data["newest"] < clock - timedelta(days=30)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "verify", "promote", "rollback", "cleanup"])
    parser.add_argument("version", nargs="?")
    parser.add_argument("--delete", action="store_true", help="Apply cleanup; default is dry-run")
    args = parser.parse_args()
    state_path = Path(".release-state.json")
    if args.action != "cleanup" and (not args.version or not VERSION.fullmatch(args.version)):
        parser.error("a valid release version is required")
    prefix = f"v{args.version}/"
    if args.action == "prepare":
        current, etag = read("_latest")
        if objects(prefix):
            raise RuntimeError(f"Refusing to overwrite existing release {args.version}; choose a new version")
        # Conditional reservation prevents concurrent publishers uploading this version.
        put(prefix + "_upload.json", json.dumps({"startedAt": now().isoformat()}), if_none_match="*")
        state_path.write_text(json.dumps({"version": args.version, "previous": current.strip(), "etag": etag}))
        print(f"Reserved {args.version}; current release is {current.strip()}")
    elif args.action == "verify":
        state = json.loads(state_path.read_text())
        if state["version"] != args.version:
            raise RuntimeError("Release does not match the prepared upload")
        local = {prefix + str(path.relative_to("dist")): path.stat().st_size for path in Path("dist").rglob("*") if path.is_file()}
        remote = {item["Key"]: item["Size"] for item in objects(prefix)}
        if prefix + "index.html" not in local or any(remote.get(key) != size for key, size in local.items()):
            raise RuntimeError("Release verification failed: missing or truncated assets")
        metadata = {"version": args.version, "publishedAt": now().isoformat(), "files": len(local)}
        put(prefix + "_release.json", json.dumps(metadata), if_none_match="*")
        print(f"Verified {len(local)} uploaded files for {args.version}")
    elif args.action in ("promote", "rollback"):
        current, etag = read("_latest")
        if args.action == "promote":
            state = json.loads(state_path.read_text())
            if state["version"] != args.version or state["etag"] != etag:
                raise RuntimeError("Current release changed during publishing; refusing promotion")
            read(prefix + "_release.json")
        # Legacy rollback candidates predate _release.json, but must contain HTML.
        aws("head-object", key=prefix + "index.html")
        # Refresh a retention lease before activation so rollback targets get 30 days.
        put(prefix + "_retained.json", json.dumps({"activatedAt": now().isoformat()}))
        put("_latest", args.version, if_match=etag)
        print(f"Promoted {args.version} (previous: {current.strip()})")
    else:
        current, etag = read("_latest")
        plan = cleanup_plan(objects(), current.strip(), now())
        for version, keys in plan.items():
            print(f"{'DELETE' if args.delete else 'WOULD DELETE'} {version}: {len(keys)} files")
            if args.delete:
                # Cleanup must run under the same deployment lock as promotion.
                if read("_latest")[1] != etag:
                    raise RuntimeError("Release changed during cleanup; stopping")
                for offset in range(0, len(keys), 1000):
                    result = aws("delete-objects", delete=json.dumps({"Objects": [{"Key": key} for key in keys[offset:offset+1000]], "Quiet": True}))
                    if result.get("Errors"):
                        raise RuntimeError(f"Cleanup failed: {result['Errors']}")
        print(f"Cleanup {'applied' if args.delete else 'dry-run'}: {len(plan)} releases; current={current.strip()}; retention=30 days + 2 rollback candidates")


if __name__ == "__main__":
    main()
