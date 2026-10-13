"""Isolated HTTP scheduler for browser tests. Capture email; never contact a mail provider."""
import os
import threading
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from vgi_reporting_reference.server import app
from vgi_reporting_reference.execution import Driver


class Server(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class Quiet(WSGIRequestHandler):
    def log_message(self, *args):
        pass


server = make_server("127.0.0.1", 0, lambda *_: [], server_class=Server, handler_class=Quiet)
url = f"http://127.0.0.1:{server.server_port}"
os.environ.update(REPORTING_PUBLIC_URL=url, REPORTING_ALLOWED_SOURCES=url, REPORTING_ALLOWED_REPORT_SERVICES=url,
                  REPORTING_EMAIL_PROVIDER="capture", REPORTING_EMAIL_DOMAINS="example.test", REPORTING_EMAIL_ADDRESSES="",
                  VGI_NOTIFY_SENDERS="reporting-scheduler", REPORTING_NOTIFY_DELEGATES="reporting-scheduler")
os.environ.pop("RESEND_API_KEY", None)
os.environ.pop("REPORTING_SMTP_HOST", None)
if os.getenv("REPORTING_TEST_LEGACY_IDENTITY") == "1":
    from typing import ClassVar, Protocol
    from vgi_rpc.rpc import RpcServer
    from vgi_rpc.rpc._token_identity import Identity, TokenIdentity, IssuedGrant

    class LegacyIdentity(Protocol):
        protocol_name: ClassVar[str] = Identity.protocol_name

        def introspect_token(self, token: str) -> TokenIdentity: ...
        def issue_grant(self, purpose: str, scopes: list[str], ttl_seconds: int) -> IssuedGrant: ...

    original_binding = RpcServer._build_binding
    def legacy_binding(self, proto, impl, *, allow_reserved=False):
        return original_binding(self, LegacyIdentity if proto is Identity else proto, impl, allow_reserved=allow_reserved)
    RpcServer._build_binding = legacy_binding
elif os.getenv("REPORTING_TEST_UNSUPPORTED_IDENTITY") == "1":
    from vgi_rpc.rpc._token_identity import IdentityImpl
    from vgi_rpc.rpc._common import MethodNotImplementedError

    def unsupported(self, ctx):
        raise MethodNotImplementedError("profile and policy reads are not implemented")
    IdentityImpl.get_current_identity = unsupported
    IdentityImpl.get_grant_policy = unsupported
server.set_app(app())


def execute():
    driver = Driver(os.environ["REPORTING_DB"])
    while True:
        driver.tick()
        threading.Event().wait(0.25)


threading.Thread(target=execute, daemon=True).start()
print(f"PORT:{server.server_port}", flush=True)
server.serve_forever()
