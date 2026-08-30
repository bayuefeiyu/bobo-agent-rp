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
JPEG_SIGNATURE = b"\xff\xd8\xff"
WEBP_RIFF = b"RIFF"


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


def image_kind(payload: bytes) -> tuple[str, str] | None:
    if payload.startswith(PNG_SIGNATURE):
        return ".png", "image/png"
    if payload.startswith(JPEG_SIGNATURE):
        return ".jpg", "image/jpeg"
    if len(payload) >= 12 and payload.startswith(WEBP_RIFF) and payload[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


def card_asset_entries(card: Any) -> list[dict[str, Any]]:
    if not isinstance(card, dict):
        return []
    data = card.get("data") if isinstance(card.get("data"), dict) else card
    assets = data.get("assets") if isinstance(data, dict) else None
    return [item for item in assets if isinstance(item, dict)] if isinstance(assets, list) else []


def embedded_asset_name(uri: Any, names: list[str]) -> str | None:
    if not isinstance(uri, str):
        return None
    normalized = uri.replace("\\", "/")
    for prefix in ("embeded://", "embedded://", "charx://"):
        if normalized.lower().startswith(prefix):
            normalized = normalized[len(prefix):].lstrip("/")
            break
    else:
        return None
    if normalized in names:
        return normalized
    matches = [name for name in names if name.replace("\\", "/").endswith(f"/{normalized}")]
    return matches[0] if len(matches) == 1 else None


def select_charx_cover(card: Any, archive: zipfile.ZipFile, names: list[str]) -> tuple[tuple[str, bytes] | None, list[str]]:
    icon_assets = [item for item in card_asset_entries(card) if str(item.get("type", "")).lower() in {"icon", "avatar", "cover"}]
    candidates: list[str] = []
    for asset in icon_assets:
        name = embedded_asset_name(asset.get("uri"), names)
        if name and name not in candidates:
            candidates.append(name)
    if not candidates:
        for name in names:
            normalized = name.replace("\\", "/").lower()
            stem = Path(normalized).stem
            if stem in {"icon", "avatar", "cover"} or "/icon/" in normalized:
                candidates.append(name)
    valid: list[tuple[str, bytes]] = []
    for name in candidates:
        payload = archive.read(name)
        if image_kind(payload):
            valid.append((name, payload))
    return (valid[0] if valid else None), [name for name, _ in valid]


def extract_charx(path: Path) -> tuple[Any, dict[str, Any]]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if "card.json" not in names:
                raise ValueError("CHARX archive does not contain card.json at its root")
            card = parse_json_bytes(archive.read("card.json"), "CHARX card.json")
            assets = sorted(name for name in names if name != "card.json" and not name.endswith("/"))
            cover, cover_candidates = select_charx_cover(card, archive, assets)
            cover_details = None
            if cover:
                cover_name, cover_payload = cover
                extension, mime_type = image_kind(cover_payload) or ("", "")
                cover_details = {
                    "available": True,
                    "archive_path": cover_name,
                    "extension": extension,
                    "mime_type": mime_type,
                    "candidate_paths": cover_candidates,
                    "ambiguous": len(cover_candidates) > 1,
                }
            return card, {"format": "charx", "embedded_files": assets, "cover": cover_details or {"available": False}}
    except zipfile.BadZipFile as error:
        raise ValueError(f"Input is not a valid CHARX ZIP archive: {error}") from error


def extract_with_cover(path: Path) -> tuple[dict[str, Any], bytes | None, str | None]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        card, details = extract_json(path)
        cover_bytes = None
        cover_extension = None
    elif suffix in {".png", ".apng"}:
        card, details = extract_png(path)
        cover_bytes = path.read_bytes()
        cover_extension = ".png"
        details["cover"] = {"available": True, "source": "packaged-card", "extension": ".png", "mime_type": "image/png"}
    elif suffix == ".charx":
        card, details = extract_charx(path)
        cover_bytes = None
        cover_extension = None
        cover = details.get("cover")
        if isinstance(cover, dict) and cover.get("available") and isinstance(cover.get("archive_path"), str):
            with zipfile.ZipFile(path) as archive:
                cover_bytes = archive.read(cover["archive_path"])
            cover_extension = cover.get("extension")
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
    }, cover_bytes, cover_extension


def extract(path: Path) -> dict[str, Any]:
    """Return extracted metadata and card data without writing packaged assets."""
    result, _, _ = extract_with_cover(path)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Source .json, .png, .apng, or .charx card")
    parser.add_argument("output", type=Path, help="Destination extracted JSON file")
    parser.add_argument(
        "--asset-directory",
        type=Path,
        help="During formal conversion, preserve an available authored cover here as original.png/jpg/webp",
    )
    arguments = parser.parse_args()

    if not arguments.input.is_file():
        parser.error(f"input file does not exist: {arguments.input}")
    try:
        result, cover_bytes, cover_extension = extract_with_cover(arguments.input)
        if arguments.asset_directory is not None and cover_bytes is not None and cover_extension is not None:
            arguments.asset_directory.mkdir(parents=True, exist_ok=True)
            cover_path = arguments.asset_directory / f"original{cover_extension}"
            cover_path.write_bytes(cover_bytes)
            result["source"]["cover"]["preserved_path"] = str(cover_path.resolve())
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
