import importlib.util
import os
import unittest

from support import ServiceTestCase

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = os.path.join(ROOT, "..", "contract", "check.py")


def load_checker():
    spec = importlib.util.spec_from_file_location("contract_check", CHECK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(os.path.exists(CHECK), "skipped: ../contract/check.py not found, put the contract repo next to this one")
class ContractTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.check = load_checker()

    def assertValid(self, schema, payload):
        self.assertEqual(self.check.validate(schema, payload), [], payload)

    def test_items(self):
        _, item, _ = self.call("POST", "/items", {"sku": "C-1", "name": "Contract", "price_cents": 10})
        self.assertValid("Item", item)
        self.assertValid("ItemList", self.call("GET", "/items")[1])

    def test_stock(self):
        item = self.add_item(stock=3)
        self.assertValid("Stock", self.call("GET", "/stock/%d" % item["id"])[1])
        self.assertValid("Stock", self.call("PUT", "/stock/%d" % item["id"], {"qty": 9})[1])

    def test_orders(self):
        item = self.add_item(stock=3)
        _, order, _ = self.call("POST", "/orders", {"item_id": item["id"], "qty": 2})
        self.assertValid("Order", order)
        self.assertValid("OrderList", self.call("GET", "/orders")[1])
        self.assertValid("Order", self.call("POST", "/orders/%d/cancel" % order["id"])[1])

    def test_requests_match_contract_schemas(self):
        self.assertValid("NewItem", {"sku": "R-1", "name": "Req", "price_cents": 5})
        self.assertValid("StockUpdate", {"qty": 5})
        self.assertValid("NewOrder", {"item_id": 1, "qty": 1})
