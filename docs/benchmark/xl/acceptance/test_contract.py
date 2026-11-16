import glob
import os
import re
import subprocess
import sys
import unittest

import helpers

SIX = ["Item", "Stock", "Order", "ItemPage", "OrderPage", "Error"]


class ContractTests(unittest.TestCase):
    def test_version_is_2(self):
        self.assertEqual(helpers.load_api()["version"], "2")

    def test_schema_names_kept(self):
        schemas = helpers.load_api()["schemas"]
        for name in ("Item", "Stock", "Order"):
            self.assertIn(name, schemas)

    def test_new_schema_names(self):
        schemas = helpers.load_api()["schemas"]
        for name in ("ItemPage", "OrderPage", "Error"):
            self.assertIn(name, schemas)
        for name in ("ItemList", "OrderList"):
            self.assertNotIn(name, schemas, "%s should be replaced" % name)

    def test_check_py_passes_with_an_example_per_schema(self):
        examples = glob.glob(os.path.join(helpers.CONTRACT_DIR, "examples", "*.json"))
        have = {os.path.basename(p).split(".")[0] for p in examples}
        self.assertEqual([n for n in SIX if n not in have], [], "missing examples")
        run = subprocess.run([sys.executable, "check.py"], cwd=helpers.CONTRACT_DIR,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.assertEqual(run.returncode, 0, run.stdout)

    def test_error_schema_describes_the_envelope(self):
        check = helpers.load_check()
        good = {"error": {"code": "not_found", "message": "no such item", "details": {}}}
        self.assertEqual(check.validate("Error", good), [])
        for bad in ({}, {"error": {"code": "x", "message": "m"}},
                    {"error": {"code": 1, "message": "m", "details": {}}},
                    {"error": "text"}):
            self.assertNotEqual(check.validate("Error", bad), [], bad)

    def test_schemas_use_quantity_and_cursor(self):
        check = helpers.load_check()
        self.assertEqual(check.validate("Stock", {"item_id": 1, "quantity": 3}), [])
        self.assertNotEqual(check.validate("Stock", {"item_id": 1, "qty": 3}), [])
        order = {"id": 1, "item_id": 1, "quantity": 2, "status": "open"}
        self.assertEqual(check.validate("Order", order), [])
        page = {"items": [{"id": 1, "sku": "A", "name": "N", "price_cents": 1}], "next_cursor": None}
        self.assertEqual(check.validate("ItemPage", page), [])
        self.assertEqual(check.validate("ItemPage", dict(page, next_cursor="abc")), [])
        self.assertEqual(check.validate("OrderPage", {"orders": [order], "next_cursor": "c"}), [])

    def test_qty_documented_as_deprecated_alias(self):
        with open(os.path.join(helpers.CONTRACT_DIR, "api.json"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertEqual(helpers.load_api()["version"], "2")
        self.assertTrue(re.search(r"deprecat", text, re.I), "api.json does not mention deprecation of qty")


if __name__ == "__main__":
    unittest.main()
