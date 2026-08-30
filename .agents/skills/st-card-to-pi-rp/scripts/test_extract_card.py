from __future__ import annotations

import base64
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("extract_card.py")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def card_png(card: dict[str, object]) -> bytes:
    encoded = base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8"))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    pixels = zlib.compress(b"\x00\x00\x00\x00\xff")
    return PNG_SIGNATURE + png_chunk(b"IHDR", ihdr) + png_chunk(b"tEXt", b"chara\0" + encoded) + png_chunk(b"IDAT", pixels) + png_chunk(b"IEND", b"")


class ExtractCardTests(unittest.TestCase):
    def run_extract(self, source: Path, output: Path, asset_directory: Path | None = None) -> dict[str, object]:
        command = [sys.executable, str(SCRIPT), str(source), str(output)]
        if asset_directory is not None:
            command.extend(["--asset-directory", str(asset_directory)])
        subprocess.run(command, check=True, capture_output=True, text=True)
        return json.loads(output.read_text(encoding="utf-8"))

    def test_png_preserves_exact_packaged_cover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "card.apng"
            image = card_png({"name": "测试角色", "description": "测试"})
            source.write_bytes(image)
            result = self.run_extract(source, root / "extracted.json", root / "assets")
            self.assertEqual((root / "assets" / "original.png").read_bytes(), image)
            self.assertEqual(result["source"]["format"], "png")
            self.assertTrue(result["source"]["cover"]["available"])
            self.assertEqual(result["source"]["cover"]["mime_type"], "image/png")

    def test_charx_extracts_declared_icon_not_background(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "card.charx"
            icon = card_png({"name": "not-card-metadata"})
            background = b"\xff\xd8\xffbackground"
            card = {
                "spec": "chara_card_v3",
                "spec_version": "3.0",
                "data": {
                    "name": "测试角色",
                    "assets": [
                        {"type": "background", "uri": "embeded://assets/background/scene.jpg", "name": "scene", "ext": "jpg"},
                        {"type": "icon", "uri": "embeded://assets/icon/main.png", "name": "main", "ext": "png"},
                    ],
                },
            }
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("card.json", json.dumps(card, ensure_ascii=False))
                archive.writestr("assets/background/scene.jpg", background)
                archive.writestr("assets/icon/main.png", icon)
            result = self.run_extract(source, root / "extracted.json", root / "assets")
            self.assertEqual((root / "assets" / "original.png").read_bytes(), icon)
            self.assertEqual(result["source"]["cover"]["archive_path"], "assets/icon/main.png")

    def test_json_does_not_invent_cover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "card.json"
            source.write_text(json.dumps({"name": "无图角色"}, ensure_ascii=False), encoding="utf-8")
            result = self.run_extract(source, root / "extracted.json", root / "assets")
            self.assertFalse((root / "assets").exists())
            self.assertNotIn("cover", result["source"])


if __name__ == "__main__":
    unittest.main()
