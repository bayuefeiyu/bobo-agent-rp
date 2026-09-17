#!/usr/bin/env python3
"""Validate the global narrative-memory package with the repository validator."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


MODULE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = MODULE_ROOT.parents[1]
VALIDATOR_PATH = REPOSITORY_ROOT / ".agents" / "skills" / "st-card-to-pi-rp" / "scripts" / "validate_card_pack.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("pi_rp_validate_card_pack", VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load validator: {VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    validator = load_validator()
    errors: list[str] = []
    warnings: list[str] = []
    validator.validate_feature_modules(
        REPOSITORY_ROOT,
        ["global-modules/narrative-memory/module.json"],
        errors,
        warnings,
    )

    for warning in warnings:
        print(f"warning: {warning}")
    if errors:
        print("Narrative-memory validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Narrative-memory Module v6 package and owned workflow registry are structurally valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
