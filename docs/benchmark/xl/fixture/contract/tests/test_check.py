import glob
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import check  # noqa: E402


class ScalarRules(unittest.TestCase):
    def test_valid_item(self):
        item = {"id": 1, "sku": "A", "name": "Thing", "price_cents": 0}
        self.assertEqual(check.validate("Item", item), [])

    def test_missing_required(self):
        errors = check.validate("Item", {"id": 1, "sku": "A", "name": "Thing"})
        self.assertEqual(len(errors), 1)
        self.assertIn("price_cents", errors[0])

    def test_wrong_type(self):
        errors = check.validate("Item", {"id": "1", "sku": "A", "name": "T", "price_cents": 5})
        self.assertEqual(len(errors), 1)
        self.assertIn("$.id", errors[0])
        self.assertIn("expected integer", errors[0])

    def test_bool_is_not_integer(self):
        errors = check.validate("Stock", {"item_id": True, "qty": 1})
        self.assertEqual(len(errors), 1)

    def test_minimum(self):
        errors = check.validate("Stock", {"item_id": 1, "qty": -1})
        self.assertEqual(len(errors), 1)
        self.assertIn("minimum", errors[0])

    def test_enum(self):
        errors = check.validate("Order", {"id": 1, "item_id": 1, "qty": 1, "status": "lost"})
        self.assertEqual(len(errors), 1)
        self.assertIn("status", errors[0])

    def test_additional_properties_false(self):
        errors = check.validate("StockUpdate", {"qty": 1, "extra": True})
        self.assertEqual(len(errors), 1)
        self.assertIn("extra", errors[0])

    def test_unknown_schema(self):
        errors = check.validate("Nope", {})
        self.assertEqual(len(errors), 1)
        self.assertIn("unknown schema", errors[0])


class ComposedRules(unittest.TestCase):
    def test_reference_and_array_items(self):
        payload = {"items": [{"id": 1, "sku": "A", "name": "T", "price_cents": 1},
                             {"id": "x", "sku": "B", "name": "U", "price_cents": 2}],
                   "total": 2}
        errors = check.validate("ItemList", payload)
        self.assertEqual(len(errors), 1)
        self.assertIn("$.items[1].id", errors[0])

    def test_payload_not_an_object(self):
        errors = check.validate("Item", [])
        self.assertEqual(errors, ["$: expected object, got array"])

    def test_type_list_and_maximum(self):
        api = {"schemas": {"X": {"type": ["integer", "null"], "maximum": 3}}}
        self.assertEqual(check.validate("X", None, api), [])
        self.assertEqual(check.validate("X", 3, api), [])
        self.assertEqual(len(check.validate("X", 4, api)), 1)
        self.assertEqual(len(check.validate("X", "4", api)), 1)


class Examples(unittest.TestCase):
    def test_every_schema_has_an_example(self):
        api = check.load_api()
        names = {os.path.basename(p).split(".")[0]
                 for p in glob.glob(os.path.join(ROOT, "examples", "*.json"))}
        self.assertEqual(sorted(set(api["schemas"]) - names), [])

    def test_all_examples_validate(self):
        checked, problems = check.check_examples()
        self.assertGreaterEqual(checked, len(check.load_api()["schemas"]))
        self.assertEqual(problems, [])

    def test_script_exit_codes(self):
        ok = subprocess.run([sys.executable, "check.py"], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(ok.returncode, 0, ok.stdout)

    def test_endpoints_reference_known_schemas(self):
        api = check.load_api()
        for endpoint in api["endpoints"]:
            for key in ("request", "response"):
                name = endpoint[key]
                if name is not None:
                    self.assertIn(name, api["schemas"], endpoint)

    def test_version_is_a_string(self):
        with open(os.path.join(ROOT, "api.json"), encoding="utf-8") as fh:
            self.assertIsInstance(json.load(fh)["version"], str)


if __name__ == "__main__":
    unittest.main()
