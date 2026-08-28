#!/usr/bin/env python3
"""Extract a SillyTavern card JSON from JSON, PNG/APNG, or CHARX input."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from typing import Any

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_json_bytes(payload: bytes, label: str) -> Any:
    try:
        return json.loads(payload.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label} does not contain valid UTF-8 JSON: {error}") from error


def decode_card_text(value: str, label: str) -> Any:
    stripped = value.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    padded = stripped + "=" * (-len(stripped) % 4)
    try:
        decoded = base64.b64decode(padded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError(f"PNG chunk {label!r} is neither JSON nor valid base64: {error}") from error
    return parse_json_bytes(decoded, f"PNG chunk {label!r}")


def parse_itxt(data: bytes) -> tuple[str, str]:
    keyword, rest = data.split(b"\0", 1)
    if len(rest) < 2:
        raise ValueError("Malformed iTXt chunk")
    compressed, method = rest[0], rest[1]
    remainder = rest[2:]
    _, remainder = remainder.split(b"\0", 1)  # language tag
    _, text = remainder.split(b"\0", 1)  # translated keyword
    if compressed:
        if method != 0:
            raise ValueError("Unsupported iTXt compression method")
        text = zlib.decompress(text)
    return keyword.decode("latin-1"), text.decode("utf-8")


def png_text_chunks(path: Path) -> dict[str, list[str]]:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("Input is not a valid PNG/APNG file")

    chunks: dict[str, list[str]] = {}
    offset = len(PNG_SIGNATURE)
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        start = offset + 8
        end = start + length
        if end + 4 > len(data):
            raise ValueError("PNG chunk length exceeds file size")
        payload = data[start:end]

        try:
            if chunk_type == b"tEXt":
                keyword, value = payload.split(b"\0", 1)
                key = keyword.decode("latin-1")
                text = value.decode("latin-1")
            elif chunk_type == b"zTXt":
                keyword, compressed = payload.split(b"\0", 1)
                if not compressed or compressed[0] != 0:
                    raise ValueError("Unsupported zTXt compression method")
                key = keyword.decode("latin-1")
                text = zlib.decompress(compressed[1:]).decode("latin-1")
            elif chunk_type == b"iTXt":
                key, text = parse_itxt(payload)
            else:
                key = text = ""
        except (ValueError, UnicodeDecodeError, zlib.error) as error:
            raise ValueError(f"Could not decode PNG {chunk_type.decode('ascii', 'replace')} chunk: {error}") from error

        if key:
            chunks.setdefault(key, []).append(text)
        offset = end + 4
        if chunk_type == b"IEND":
            break
    return chunks


def infer_spec(card: Any) -> str:
    if not isinstance(card, dict):
        return "unknown"
    if isinstance(card.get("spec"), str):
        version = card.get("spec_version")
        return f"{card['spec']}:{version}" if version else card["spec"]
    v1_fields = {"name", "description", "personality", "scenario", "first_mes", "mes_example"}
    return "tavern-card-v1" if v1_fields.intersection(card) else "unknown"


def extract_json(path: Path) -> tuple[Any, dict[str, Any]]:
    card = parse_json_bytes(path.read_bytes(), str(path))
    return card, {"format": "json"}


def extract_png(path: Path) -> tuple[Any, dict[str, Any]]:
    chunks = png_text_chunks(path)
    for keyword in ("ccv3", "chara"):
        values = chunks.get(keyword, [])
        if values:
            card = decode_card_text(values[-1], keyword)
            return card, {
                "format": "png",
                "selected_chunk": keyword,
                "available_card_chunks": [name for name in ("ccv3", "chara") if name in chunks],
            }
    raise ValueError("PNG does not contain a ccv3 or chara card chunk")


def extract_charx(path: Path) -> tuple[Any, dict[str, Any]]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if "card.json" not in names:
                raise ValueError("CHARX archive does not contain card.json at its root")
            card = parse_json_bytes(archive.read("card.json"), "CHARX card.json")
            assets = sorted(name for name in names if name != "card.json" and not name.endswith("/"))
            return card, {"format": "charx", "embedded_files": assets}
    except zipfile.BadZipFile as error:
        raise ValueError(f"Input is not a valid CHARX ZIP archive: {error}") from error


def extract(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        card, details = extract_json(path)
    elif suffix in {".png", ".apng"}:
        card, details = extract_png(path)
    elif suffix == ".charx":
        card, details = extract_charx(path)
    else:
        raise ValueError("Supported inputs are .json, .png, .apng, and .charx")

    return {
        "source": {
            "path": str(path.resolve()),
            "sha256": sha256_file(path),
            "card_spec": infer_spec(card),
            **details,
        },
        "card": card,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Source .json, .png, .apng, or .charx card")
    parser.add_argument("output", type=Path, help="Destination extracted JSON file")
    arguments = parser.parse_args()

    if not arguments.input.is_file():
        parser.error(f"input file does not exist: {arguments.input}")
    try:
        result = extract(arguments.input)
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
