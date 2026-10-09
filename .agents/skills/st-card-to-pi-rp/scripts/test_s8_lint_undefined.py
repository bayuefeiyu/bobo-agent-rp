from pathlib import Path
import tempfile
import unittest

from s8_lint_undefined import check


class UndefinedReferenceTests(unittest.TestCase):
    def probe(self, source):
        with tempfile.TemporaryDirectory(prefix="rp-undefined-") as directory:
            path = Path(directory) / "fixture.py"
            path.write_text(source, encoding="utf-8")
            return check(path)

    def test_closure_parameters_and_locals_are_available(self):
        self.assertEqual(self.probe("def outer(errors):\n    prefix = 'x'\n    def visit(value):\n        errors.append(prefix + value)\n    return visit\n"), [])

    def test_nested_import_does_not_define_a_module_global(self):
        problems = self.probe("def first():\n    import json\n    return json.loads('{}')\ndef second():\n    return json.loads('{}')\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("'json'", problems[0])
        self.assertIn("second()", problems[0])

    def test_missing_import_is_reported(self):
        self.assertIn("'re'", self.probe("def check(value):\n    return re.match('x', value)\n")[0])


if __name__ == "__main__":
    unittest.main()
