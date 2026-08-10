import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

import zstandard


EXTRACTOR = pathlib.Path(__file__).parents[1] / "server" / "sync" / "extract-tar-zstd.py"


class ExtractTarZstdTest(unittest.TestCase):
    def test_extracts_only_the_requested_file_without_system_zstd(self):
        payload = b"fixture parquet bytes"
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            tar_path = root / "plateau.tar"
            archive_path = root / "plateau.tar.zst"
            output_path = root / "nested" / "buildings.parquet"

            with tarfile.open(tar_path, "w") as archive:
                member = tarfile.TarInfo("buildings.parquet")
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            archive_path.write_bytes(zstandard.ZstdCompressor().compress(tar_path.read_bytes()))

            subprocess.run([
                sys.executable, str(EXTRACTOR), "--archive", str(archive_path),
                "--output", str(output_path), "--member", "buildings.parquet"
            ], check=True, capture_output=True, text=True)

            self.assertEqual(output_path.read_bytes(), payload)


if __name__ == "__main__":
    unittest.main()
