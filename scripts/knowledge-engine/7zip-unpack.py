"""Extract only regular, checksum-verified upstream tool and license members."""
import hashlib
import pathlib
import sys
import tarfile

archive_path, output_path = map(pathlib.Path, sys.argv[1:])
expected = '22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e'
if hashlib.sha256(archive_path.read_bytes()).hexdigest() != expected:
    raise SystemExit('Tool archive checksum mismatch')
root = output_path.resolve(strict=True)
allowed = {'7zz': '7zz', 'License.txt': 'License.txt', 'readme.txt': 'readme.txt', 'MANUAL/general/license.htm': 'license.htm'}
with tarfile.open(archive_path, 'r:xz') as archive:
    for source, name in allowed.items():
        member = archive.getmember(source)
        if not member.isfile() or member.size > 4_000_000:
            raise SystemExit('Unsafe tool archive member')
        target = root / name
        if target.exists() or target.is_symlink():
            raise SystemExit('Tool extraction target already exists')
        with target.open('xb') as output:
            output.write(archive.extractfile(member).read())