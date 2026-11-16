import contextlib
import io
import json
import unittest

from orders_client.cli import main
from stub import StubServer


def run_cli(url, *argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(["--url", url] + list(argv))
    return code, out.getvalue(), err.getvalue()


class CliTests(unittest.TestCase):
    def test_items_list_with_paging(self):
        with StubServer(default=(200, {"items": [], "total": 0})) as stub:
            code, out, _ = run_cli(stub.url, "items", "list", "--offset", "5", "--limit", "7")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"items": [], "total": 0})
        self.assertEqual(stub.requests[0]["path"], "/items?offset=5&limit=7")

    def test_items_add(self):
        with StubServer(default=(201, {"id": 1})) as stub:
            code, out, _ = run_cli(stub.url, "items", "add", "S-1", "Some name", "250")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stub.requests[0]["body"]),
                         {"sku": "S-1", "name": "Some name", "price_cents": 250})

    def test_stock_commands(self):
        with StubServer(default=(200, {"item_id": 2, "qty": 6})) as stub:
            run_cli(stub.url, "stock", "get", "2")
            run_cli(stub.url, "stock", "set", "2", "6")
        self.assertEqual(stub.requests[0]["path"], "/stock/2")
        self.assertEqual(json.loads(stub.requests[1]["body"]), {"qty": 6})

    def test_orders_commands(self):
        with StubServer(default=(200, {"id": 1})) as stub:
            run_cli(stub.url, "orders", "list")
            run_cli(stub.url, "orders", "create", "2", "3")
            run_cli(stub.url, "orders", "cancel", "1")
        self.assertEqual(stub.requests[0]["path"], "/orders?offset=0&limit=20")
        self.assertEqual(json.loads(stub.requests[1]["body"]), {"item_id": 2, "qty": 3})
        self.assertEqual(stub.requests[2]["path"], "/orders/1/cancel")

    def test_api_error_exits_one(self):
        with StubServer(default=(404, {"message": "not found"})) as stub:
            code, out, err = run_cli(stub.url, "stock", "get", "9")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("404", err)

    def test_missing_command_is_a_usage_error(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                main(["--url", "http://127.0.0.1:1"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
