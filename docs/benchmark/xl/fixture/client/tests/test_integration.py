"""Runs the real service from ../service as a subprocess and talks to it."""
import contextlib
import io
import json
import os
import subprocess
import sys
import threading
import unittest

from orders_client import ApiError, Client
from orders_client.cli import main

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVICE = os.path.normpath(os.path.join(ROOT, "..", "service"))


def start_service():
    proc = subprocess.Popen([sys.executable, "-m", "orders_service", "--port", "0"], cwd=SERVICE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
    line = []
    reader = threading.Thread(target=lambda: line.append(proc.stdout.readline()), daemon=True)
    reader.start()
    reader.join(10)
    if not line or not line[0].startswith("listening on "):
        proc.kill()
        proc.wait()
        raise RuntimeError("service did not announce a port: %r" % line)
    return proc, int(line[0].split()[-1])


@unittest.skipUnless(os.path.isdir(SERVICE), "skipped: ../service not found, put the service repo next to this one")
class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc, port = start_service()
        cls.url = "http://127.0.0.1:%d" % port
        cls.client = Client(cls.url)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.wait()
        cls.proc.stdout.close()

    def new_item(self, sku, stock=None):
        item = self.client.create_item(sku, "Integration " + sku, 100)
        if stock is not None:
            self.client.set_stock(item["id"], stock)
        return item

    def test_item_roundtrip(self):
        item = self.new_item("INT-ROUND")
        self.assertEqual(self.client.get_item(item["id"]), item)
        listed = self.client.list_items(offset=0, limit=100)
        self.assertIn(item, listed["items"])
        self.assertGreaterEqual(listed["total"], 1)

    def test_stock_and_order_flow(self):
        item = self.new_item("INT-FLOW", stock=5)
        order = self.client.create_order(item["id"], 2)
        self.assertEqual(order["status"], "open")
        self.assertEqual(self.client.get_stock(item["id"])["qty"], 3)
        cancelled = self.client.cancel_order(order["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.client.get_stock(item["id"])["qty"], 5)
        self.assertEqual(self.client.get_order(order["id"])["status"], "cancelled")

    def test_paging(self):
        for n in range(3):
            self.new_item("INT-PAGE-%d" % n)
        first = self.client.list_items(offset=0, limit=2)
        second = self.client.list_items(offset=2, limit=2)
        self.assertEqual(len(first["items"]), 2)
        self.assertEqual(first["items"][-1]["id"] + 1, second["items"][0]["id"])

    def test_errors_surface_as_api_error(self):
        with self.assertRaises(ApiError) as ctx:
            self.client.get_item(987654)
        self.assertEqual(ctx.exception.status, 404)
        item = self.new_item("INT-ERR", stock=1)
        with self.assertRaises(ApiError) as ctx:
            self.client.create_order(item["id"], 5)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("insufficient stock", ctx.exception.body)

    def test_cli_against_real_service(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["--url", self.url, "items", "add", "INT-CLI", "Cli item", "10"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["sku"], "INT-CLI")


if __name__ == "__main__":
    unittest.main()
