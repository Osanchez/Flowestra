"""A scriptable stub HTTP server for client tests."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        stub = self.server.stub
        stub.requests.append({"method": self.command, "path": self.path, "body": body,
                              "headers": dict(self.headers.items())})
        status, payload = stub.next_response()
        data = payload if isinstance(payload, str) else json.dumps(payload)
        data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = _handle


class StubServer:
    """Replies with queued (status, payload) pairs, then with the default."""

    def __init__(self, default=(200, {})):
        self.default = default
        self.queue = []
        self.requests = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._server.stub = self
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={"poll_interval": 0.02}, daemon=True)

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self._server.server_address[1]

    def reply(self, *responses):
        self.queue.extend(responses)
        return self

    def next_response(self):
        return self.queue.pop(0) if self.queue else self.default

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(5)
