"""Shared plumbing for the hidden acceptance suite.

XL_WORK must point at the folder holding contract/, service/ and client/.
The service is started the documented way (`python3 -m orders_service --port 0 --db <file>`)
and everything is checked black-box over HTTP, through the client package or through the
client CLI.
"""
import importlib
import importlib.util
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORK = os.environ.get("XL_WORK")
if not WORK:
    raise RuntimeError("set XL_WORK to the folder holding contract/, service/ and client/")
WORK = os.path.abspath(WORK)
CONTRACT_DIR = os.path.join(WORK, "contract")
SERVICE_DIR = os.path.join(WORK, "service")
CLIENT_DIR = os.path.join(WORK, "client")

if CLIENT_DIR not in sys.path:
    sys.path.insert(0, CLIENT_DIR)

_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_check():
    spec = importlib.util.spec_from_file_location("xl_contract_check", os.path.join(CONTRACT_DIR, "check.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_api():
    with open(os.path.join(CONTRACT_DIR, "api.json"), encoding="utf-8") as fh:
        return json.load(fh)


class Service:
    """The real service in a subprocess."""

    def __init__(self, db_path):
        self.db_path = db_path
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "orders_service", "--port", "0", "--db", db_path],
            cwd=SERVICE_DIR, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
        lines = queue.Queue()

        def pump():
            for line in self.proc.stdout:
                lines.put(line)

        threading.Thread(target=pump, daemon=True).start()
        try:
            first = lines.get(timeout=15)
        except queue.Empty:
            self.stop()
            raise RuntimeError("service printed no 'listening on' line within 15 s")
        if not first.startswith("listening on "):
            self.stop()
            raise RuntimeError("unexpected first line from the service: %r" % first)
        self.port = int(first.split()[-1])
        self.url = "http://127.0.0.1:%d" % self.port

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdout.close()


def http(base, method, path, body=None, headers=None):
    """Return (status, decoded JSON or text, response headers)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    hdrs = dict(headers or {})
    if data is not None:
        hdrs.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(base + path, data=data, method=method, headers=hdrs)
    try:
        resp = _NO_PROXY.open(request, timeout=10)
        status, raw, resp_headers = resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as exc:
        status, raw, resp_headers = exc.code, exc.read(), exc.headers
    text = raw.decode("utf-8")
    try:
        return status, json.loads(text), resp_headers
    except ValueError:
        return status, text, resp_headers


class ServiceCase(unittest.TestCase):
    """One service (fresh database file) per test class."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls._tmp.name, "orders.db")
        cls.service = Service(cls.db_path)
        cls.addClassCleanup(cls._tmp.cleanup)
        cls.addClassCleanup(cls._stop)
        cls.base = cls.service.url
        cls._counter = 0

    @classmethod
    def _stop(cls):
        cls.service.stop()

    def call(self, method, path, body=None, headers=None):
        return http(self.base, method, path, body, headers)

    def new_item(self, stock=None):
        type(self)._counter += 1
        n = type(self)._counter
        status, item, _ = self.call("POST", "/items", {"sku": "ACC-%d-%s" % (n, os.getpid()),
                                                       "name": "Item %d" % n, "price_cents": 100 + n})
        self.assertEqual(status, 201, item)
        if stock is not None:
            status, body, _ = self.call("PUT", "/stock/%d" % item["id"], {"qty": stock})
            self.assertEqual(status, 200, body)
        return item

    def assertEnvelope(self, status, body, expected_status, expected_code):
        self.assertEqual(status, expected_status, body)
        self.assertIsInstance(body, dict, "body is not JSON: %r" % (body,))
        self.assertEqual(list(body), ["error"], body)
        error = body["error"]
        self.assertIsInstance(error, dict, body)
        self.assertEqual(sorted(error), ["code", "details", "message"], body)
        self.assertEqual(error["code"], expected_code, body)
        self.assertIsInstance(error["message"], str)
        self.assertIsInstance(error["details"], dict)


def client_errors_module(case):
    """Import orders_client.errors, failing the test (not erroring) when it is missing."""
    try:
        return importlib.import_module("orders_client.errors")
    except ImportError as exc:
        case.fail("orders_client.errors is not importable: %s" % exc)


class Stub:
    """A scriptable HTTP server recording every request."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8") if length else ""
                stub.requests.append({"method": self.command, "path": self.path, "body": body,
                                      "headers": {k.lower(): v for k, v in self.headers.items()}})
                index = min(len(stub.requests), len(stub.responses)) - 1
                status, payload = stub.responses[index]
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = _handle

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={"poll_interval": 0.02}, daemon=True)
        self.url = "http://127.0.0.1:%d" % self._server.server_address[1]

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(5)


def envelope(code, message="stub", details=None):
    return {"error": {"code": code, "message": message, "details": details or {}}}
