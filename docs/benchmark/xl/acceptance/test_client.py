import contextlib
import io
import json
import subprocess
import sys
import time
import unittest
import uuid

import helpers
from helpers import ServiceCase, Stub, client_errors_module, envelope

CODES = [
    ("not_found", 404, "NotFound"),
    ("validation_error", 400, "ValidationError"),
    ("invalid_cursor", 400, "InvalidCursor"),
    ("insufficient_stock", 409, "InsufficientStock"),
    ("invalid_state", 409, "InvalidState"),
    ("idempotency_conflict", 409, "IdempotencyConflict"),
    ("unavailable", 503, "Unavailable"),
]

ORDER = {"id": 1, "item_id": 1, "quantity": 1, "status": "open"}


def make_client(url, **kwargs):
    import orders_client
    return orders_client.Client(url, **kwargs)


class ClientAgainstStub(unittest.TestCase):
    def test_error_codes_raise_their_classes(self):
        errors = client_errors_module(self)
        for code, status, class_name in CODES:
            cls = getattr(errors, class_name, None)
            self.assertIsNotNone(cls, "orders_client.errors.%s missing" % class_name)
            self.assertTrue(issubclass(cls, errors.ApiError), class_name)
            # Unavailable is retried, so give it a single quick answer run via get_item
            responses = [(status, envelope(code, "boom", {"k": 1}))] * 3
            with Stub(responses) as stub:
                client = make_client(stub.url, retry_base_delay=0.001)
                with self.assertRaises(cls, msg=code) as ctx:
                    client.get_item(1)
            exc = ctx.exception
            self.assertEqual((exc.status, exc.code, exc.message, exc.details), (status, code, "boom", {"k": 1}))
        with Stub([(418, envelope("teapot", "short and stout"))]) as stub:
            with self.assertRaises(errors.ApiError) as ctx:
                make_client(stub.url).get_item(1)
        self.assertIs(type(ctx.exception), errors.ApiError)
        self.assertEqual(ctx.exception.code, "teapot")

    def test_api_error_is_the_same_class(self):
        import orders_client
        errors = client_errors_module(self)
        self.assertIs(orders_client.ApiError, errors.ApiError)

    def test_create_order_sends_a_key(self):
        with Stub([(201, ORDER), (201, ORDER)]) as stub:
            client = make_client(stub.url)
            result = client.create_order(1, 1)
            client.create_order(1, 1, idempotency_key="my-key")
        self.assertEqual(result, ORDER)
        generated = stub.requests[0]["headers"].get("idempotency-key")
        self.assertIsNotNone(generated, "no Idempotency-Key header sent")
        self.assertEqual(uuid.UUID(generated).version, 4)
        self.assertEqual(stub.requests[1]["headers"].get("idempotency-key"), "my-key")
        self.assertEqual(json.loads(stub.requests[0]["body"]).get("quantity"), 1)

    def test_503_is_retried_with_the_same_key(self):
        responses = [(503, envelope("unavailable")), (503, envelope("unavailable")), (201, ORDER)]
        with Stub(responses) as stub:
            result = make_client(stub.url, retry_base_delay=0.01).create_order(1, 1)
        self.assertEqual(result, ORDER)
        self.assertEqual(len(stub.requests), 3)
        keys = {r["headers"].get("idempotency-key") for r in stub.requests}
        self.assertEqual(len(keys), 1)
        self.assertNotIn(None, keys)

    def test_unavailable_after_three_attempts(self):
        errors = client_errors_module(self)
        with Stub([(503, envelope("unavailable"))] * 5) as stub:
            with self.assertRaises(errors.Unavailable):
                make_client(stub.url, retry_base_delay=0.01).create_order(1, 1)
        self.assertEqual(len(stub.requests), 3)
        self.assertEqual(len({r["headers"].get("idempotency-key") for r in stub.requests}), 1)

    def test_retry_waits_with_exponential_backoff(self):
        with Stub([(503, envelope("unavailable"))] * 3) as stub:
            client = make_client(stub.url, retry_base_delay=0.05)
            started = time.monotonic()
            with self.assertRaises(Exception):
                client.create_order(1, 1)
            elapsed = time.monotonic() - started
        self.assertEqual(len(stub.requests), 3)
        self.assertGreaterEqual(elapsed, 0.05 * 1 + 0.05 * 2 - 0.01)

    def test_other_errors_are_not_retried(self):
        errors = client_errors_module(self)
        with Stub([(409, envelope("insufficient_stock"))] * 3) as stub:
            with self.assertRaises(errors.InsufficientStock):
                make_client(stub.url, retry_base_delay=0.01).create_order(1, 5)
        self.assertEqual(len(stub.requests), 1)


class ClientAgainstService(ServiceCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ids = []
        for n in range(45):
            status, body, _ = helpers.http(cls.base, "POST", "/items", {
                "sku": "CL-%03d" % n, "name": "Client item %d" % n, "price_cents": n})
            assert status == 201, body
            cls.ids.append(body["id"])

    def client(self):
        return make_client(self.base, retry_base_delay=0.01)

    def test_iter_items_follows_cursors(self):
        client = self.client()
        self.assertEqual([i["id"] for i in client.iter_items(limit=10)], self.ids)
        self.assertEqual([i["id"] for i in client.iter_items()], self.ids)
        page = client.list_items(limit=5)
        self.assertEqual([i["id"] for i in page["items"]], self.ids[:5])
        nxt = client.list_items(limit=5, cursor=page["next_cursor"])
        self.assertEqual([i["id"] for i in nxt["items"]], self.ids[5:10])

    def test_iter_orders_and_quantity_and_replay(self):
        client = self.client()
        item_id = self.ids[0]
        stock = client.set_stock(item_id, 20)
        self.assertEqual(stock["quantity"], 20)
        first = client.create_order(item_id, 2, idempotency_key="client-replay")
        again = client.create_order(item_id, 2, idempotency_key="client-replay")
        self.assertEqual(first["quantity"], 2)
        self.assertEqual(first, again)
        client.create_order(item_id, 1)
        self.assertEqual(len(list(client.iter_orders(limit=1))), 2)
        self.assertEqual(client.get_stock(item_id)["quantity"], 17)

    def test_real_errors_map_to_exceptions(self):
        errors = client_errors_module(self)
        client = self.client()
        with self.assertRaises(errors.NotFound):
            client.get_item(99999)
        with self.assertRaises(errors.InsufficientStock):
            client.create_order(self.ids[1], 5)
        with self.assertRaises(errors.InvalidCursor):
            client.list_items(cursor="not a cursor!!")
        with self.assertRaises(errors.ValidationError):
            client.list_items(limit=0)

    def run_cli(self, *argv):
        return subprocess.run([sys.executable, "-m", "orders_client", "--url", self.base] + list(argv),
                              cwd=helpers.CLIENT_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True)

    def test_cli_items_list_all_and_limit(self):
        run = self.run_cli("items", "list", "--all")
        self.assertEqual(run.returncode, 0, run.stderr)
        records = json.loads(run.stdout)
        self.assertIsInstance(records, list)
        self.assertEqual([r["id"] for r in records], self.ids)
        run = self.run_cli("items", "list", "--limit", "4")
        self.assertEqual(run.returncode, 0, run.stderr)
        page = json.loads(run.stdout)
        self.assertEqual(len(page["items"]), 4)
        run = self.run_cli("items", "list", "--limit", "4", "--cursor", page["next_cursor"])
        self.assertEqual([i["id"] for i in json.loads(run.stdout)["items"]], self.ids[4:8])


if __name__ == "__main__":
    unittest.main()
