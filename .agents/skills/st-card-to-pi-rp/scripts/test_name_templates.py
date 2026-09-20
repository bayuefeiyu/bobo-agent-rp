import tempfile
import unittest
from pathlib import Path

from validate_card_pack import validate_name_templates


class NameTemplateValidationTests(unittest.TestCase):
    def test_runtime_character_macro_and_structural_user_macro_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "openings").mkdir()
            (root / "openings" / "00.md").write_text("{{char}} meets {{user}}", encoding="utf-8")
            (root / "manifest.json").write_text('{"id":"{{user}}","title":"{{user}}"}', encoding="utf-8")
            (root / "source").mkdir()
            (root / "source" / "original.md").write_text("{{char}}", encoding="utf-8")
            (root / "provenance.json").write_text('{"original":"{{char}}"}', encoding="utf-8")
            errors = []
            validate_name_templates(root, errors)
            self.assertTrue(any("openings/00.md contains {{char}}" in error for error in errors))
            self.assertTrue(any("manifest.json.id has a player macro" in error for error in errors))
            self.assertFalse(any("source/original.md" in error or "provenance.json" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
