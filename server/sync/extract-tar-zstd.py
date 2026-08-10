import argparse
import os
import pathlib
import shutil
import tarfile

import zstandard


parser = argparse.ArgumentParser()
parser.add_argument("--archive", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--member", required=True)
args = parser.parse_args()

archive_path = pathlib.Path(args.archive).resolve()
output_path = pathlib.Path(args.output).resolve()
temporary_path = output_path.with_name(f"{output_path.name}.{os.getpid()}.tmp")

if not archive_path.is_file():
    raise FileNotFoundError(f"archive does not exist: {archive_path}")
if not args.member or pathlib.PurePosixPath(args.member).is_absolute() or ".." in pathlib.PurePosixPath(args.member).parts:
    raise ValueError("member must be a safe relative archive path")

output_path.parent.mkdir(parents=True, exist_ok=True)
temporary_path.unlink(missing_ok=True)
try:
    found = False
    with archive_path.open("rb") as compressed:
        with zstandard.ZstdDecompressor().stream_reader(compressed) as stream:
            with tarfile.open(fileobj=stream, mode="r|") as archive:
                for member in archive:
                    if member.name != args.member:
                        continue
                    if not member.isfile():
                        raise RuntimeError(f"archive member is not a regular file: {args.member}")
                    source = archive.extractfile(member)
                    if source is None:
                        raise RuntimeError(f"archive member cannot be read: {args.member}")
                    with source, temporary_path.open("xb") as destination:
                        shutil.copyfileobj(source, destination, length=1024 * 1024)
                    found = True
                    break
    if not found:
        raise RuntimeError(f"archive member not found: {args.member}")
    os.replace(temporary_path, output_path)
finally:
    temporary_path.unlink(missing_ok=True)
