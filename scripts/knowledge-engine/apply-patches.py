#!/usr/bin/env python3
"""Apply only reviewed patches to the checksum-pinned upstream source."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

base = pathlib.Path(__file__).resolve().parent
def fail(message):
    raise RuntimeError(message)
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def inside(root, relative):
    path = (root / relative).resolve()
    if path == root or root not in path.parents:
        fail("Unsafe patch target")
    return path

try:
    lock = json.loads((base / "upstream-lock.json").read_text())
    if lock.get("schemaVersion") != 1 or not lock.get("patches") or not lock.get("securityPolicy"):
        fail("Invalid upstream patch lock")
    for item in lock["patches"] + lock["regressionTests"]:
        file = inside(base, item["file"])
        if not file.is_file() or sha(file) != item["sha256"]:
            fail("Pinned patch or regression asset checksum mismatch")
    if sys.argv[1:] == ["--verify-assets"]:
        print(json.dumps({"securityPolicy": lock["securityPolicy"], "patchCount": len(lock["patches"]), "regressionCount": len(lock["regressionTests"])}))
        sys.exit(0)
    if len(sys.argv) != 2:
        fail("Specify the isolated upstream source directory")
    source = pathlib.Path(sys.argv[1]).resolve()
    if not source.is_dir() or source == pathlib.Path(source.anchor):
        fail("Invalid upstream source directory")
    for patch in lock["patches"]:
        states = []
        for target in patch["targets"]:
            file = inside(source, target["path"])
            if not file.is_file():
                fail("Pinned patch target is missing")
            digest = sha(file)
            if digest == target["beforeSha256"]:
                states.append("before")
            elif digest == target["afterSha256"]:
                states.append("after")
            else:
                fail("Pinned upstream source target checksum mismatch")
        if all(s == "after" for s in states):
            continue
        if not all(s == "before" for s in states):
            fail("Partially patched source is not accepted")
        asset = str(inside(base, patch["file"]))
        for args in [["git", "apply", "--check", asset], ["git", "apply", asset]]:
            result = subprocess.run(args, cwd=source, capture_output=True)
            if result.returncode:
                fail("Pinned upstream patch could not be applied")
        for target in patch["targets"]:
            if sha(inside(source, target["path"])) != target["afterSha256"]:
                fail("Patched source checksum mismatch")
    for test in lock["regressionTests"]:
        target = inside(source, test["target"])
        if target.exists() and sha(target) != test["sha256"]:
            fail("Unexpected existing regression test")
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(inside(base, test["file"]), target)
    print(json.dumps({"securityPolicy": lock["securityPolicy"], "patchCount": len(lock["patches"]), "status": "applied"}))
except Exception as error:
    print("Engine patch verification failed: " + str(error), file=sys.stderr)
    sys.exit(1)
