# /// script
# requires-python = ">=3.13"
# dependencies = ["joserfc>=1.0"]
# ///
"""A fake OAuth 2.0 / OIDC identity provider for testing Cupola's token lifecycle.

Development only, like the rest of test-worker/. It speaks just enough of the
protocol for Cupola's SPA PKCE client (`src/lib/oauth-client.ts`) and the VGI
extension's WASM PKCE flow to sign in, refresh and expire, and it misbehaves on
demand the way Microsoft Entra does:

- Access and ID tokens are RS256 JWTs the test worker validates against
  `/jwks` (`access_ttl`, default 300 s). Keep it well above 60 s: Cupola
  refreshes any token within 60 s of expiry, so a shorter one is refreshed on
  every request. To end tokens early, revoke them instead (below).
- Refresh tokens have a FIXED lifetime counted from sign-in
  (`refresh_lifetime`, default 600 s), like Entra's 24-hour cap on SPA refresh
  tokens: refreshing returns a new refresh token but never extends it. Past it,
  the token endpoint answers `invalid_grant` with Entra's AADSTS700084 text.
- `/authorize` signs in at once (`authorize_mode: "auto"`), or shows a Sign in
  button so a person can take as long as a real login (`"button"`), optionally
  after `authorize_delay` seconds.

Every token carries a `gen` claim (a counter across all tokens issued) and a
`sid` (the sign-in it descends from), so a test can tell exactly which token a
request presented: the worker's `cupola_test.auth.whoami()` echoes them.

Control endpoints (CORS open, JSON):

    GET  /_test/state            config, sign-ins, issued tokens, recent events
    POST /_test/config           {"access_ttl": 30, "refresh_lifetime": 90, ...}
    POST /_test/expire-refresh   end every sign-in's refresh lifetime now
    POST /_test/revoke-access    every token issued so far is refused by the worker
    POST /_test/expire-all       both of the above (the "24 hours later" button)
    GET  /_test/revocation       {"revoked_through_gen": N}, polled by the worker
    POST /_test/reset            forget everything, restore the starting config

Revocation needs the worker's help: it caches the JWKS, so neither expiry nor a
new signing key reaches a token it has already validated. With
`CUPOLA_TEST_IDP_URL` set (run-oauth.sh sets it), the worker refuses any token
whose `gen` is at or below `revoked_through_gen`, with the same 401 an expired
token gets.

Run it through `./run-oauth.sh`, which also starts the worker behind it.
"""

import argparse
import base64
import hashlib
import html
import json
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from joserfc import jwt
from joserfc.jwk import RSAKey

DEFAULT_CONFIG: dict[str, Any] = {
    "access_ttl": 300,
    # The id_token's own lifetime; None follows access_ttl. Entra's differ (an
    # id_token lasts an hour, an access token 60-90 minutes), and `expires_in`
    # describes only the access token, which matters when the worker takes the
    # id_token as the bearer (VGI_OAUTH_USE_ID_TOKEN=1).
    "id_ttl": None,
    "refresh_lifetime": 600,
    "authorize_delay": 0,
    "authorize_mode": "auto",
    "sub": "alice",
    "email": "alice@example.test",
    "name": "Alice Example",
}

AADSTS700084 = (
    "AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore "
    "has a fixed, limited lifetime of {lifetime}, which cannot be extended. It is now "
    "expired and a new sign in request must be sent by the SPA to the sign in page."
)


class State:
    """Everything the IdP knows. One lock: the traffic is a handful of requests."""

    def __init__(self, issuer: str, client_id: str) -> None:
        self.issuer = issuer
        self.client_id = client_id
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        self.config = dict(DEFAULT_CONFIG)
        self.key = self._new_key()
        self.revoked_through_gen = 0
        self.codes: dict[str, dict[str, Any]] = {}
        # sid -> {created, refresh_expires_at, ...}
        self.sessions: dict[str, dict[str, Any]] = {}
        # refresh token -> sid
        self.refresh_tokens: dict[str, str] = {}
        self.issued: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []
        self.gen = 0

    @staticmethod
    def _new_key() -> RSAKey:
        kid = f"k{secrets.token_hex(4)}"
        return RSAKey.generate_key(2048, parameters={"kid": kid, "alg": "RS256", "use": "sig"})

    def event(self, kind: str, **data: Any) -> None:
        entry = {"t": round(time.time(), 3), "event": kind, **data}
        self.events.append(entry)
        del self.events[:-500]
        print(json.dumps(entry), flush=True)

    def mint(self, sid: str, scope: str, grant: str) -> dict[str, Any]:
        """Access + ID token (one `gen`) and a new refresh token for the sign-in."""
        session = self.sessions[sid]
        now = int(time.time())
        self.gen += 1
        ttl = int(self.config["access_ttl"])
        base = {
            "iss": self.issuer,
            "aud": self.client_id,
            "sub": session["sub"],
            "iat": now,
            "nbf": now,
            "exp": now + ttl,
            "auth_time": session["created"],
            "sid": sid,
            "gen": self.gen,
        }
        header = {"alg": "RS256", "kid": self.key.kid}
        id_ttl = ttl if self.config["id_ttl"] is None else int(self.config["id_ttl"])
        access = jwt.encode(header, {**base, "token_use": "access", "scp": scope, "jti": secrets.token_hex(8)}, self.key)
        id_token = jwt.encode(
            header,
            {**base, "exp": now + id_ttl, "token_use": "id", "email": session["email"], "name": session["name"],
             "jti": secrets.token_hex(8)},
            self.key,
        )
        refresh = f"rt.{sid}.{self.gen}.{secrets.token_urlsafe(16)}"
        self.refresh_tokens[refresh] = sid
        self.issued.append({"gen": self.gen, "sid": sid, "grant": grant, "iat": now, "exp": now + ttl,
                            "id_exp": now + id_ttl})
        del self.issued[:-500]
        self.event("token_issued", gen=self.gen, sid=sid, grant=grant, expires_in=ttl, id_expires_in=id_ttl,
                   refresh_expires_in=session["refresh_expires_at"] - now)
        return {
            "access_token": access,
            "id_token": id_token,
            "refresh_token": refresh,
            "token_type": "Bearer",
            "expires_in": ttl,
            "scope": scope,
        }

    def snapshot(self) -> dict[str, Any]:
        now = int(time.time())
        return {
            "now": now,
            "issuer": self.issuer,
            "client_id": self.client_id,
            "config": self.config,
            "gen": self.gen,
            "revoked_through_gen": self.revoked_through_gen,
            "sessions": [
                {"sid": sid, **s, "refresh_expires_in": s["refresh_expires_at"] - now}
                for sid, s in self.sessions.items()
            ],
            "issued": self.issued[-50:],
            "events": self.events[-100:],
        }


def s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def make_handler(state: State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "FakeIdP/1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler's name
            pass  # events go to stdout as JSON instead

        # -- plumbing --------------------------------------------------------

        def cors(self) -> None:
            # The token endpoint is called cross-origin from the page (Cupola)
            # and from the DuckDB worker (the extension), like an SPA's IdP.
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")

        def send_json(self, status: int, body: Any) -> None:
            data = json.dumps(body, indent=2).encode()
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def send_html(self, status: int, html: str) -> None:
            data = html.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def redirect(self, location: str) -> None:
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(length) if length else b""

        def form(self) -> dict[str, str]:
            return {k: v[0] for k, v in urllib.parse.parse_qs(self.body().decode()).items()}

        def json_body(self) -> dict[str, Any]:
            raw = self.body()
            return json.loads(raw) if raw.strip() else {}

        # -- routes ----------------------------------------------------------

        def do_OPTIONS(self) -> None:  # noqa: N802 - http.server's naming
            self.send_response(204)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            url = urllib.parse.urlsplit(self.path)
            query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            if url.path == "/.well-known/openid-configuration":
                self.send_json(200, {
                    "issuer": state.issuer,
                    "authorization_endpoint": f"{state.issuer}/authorize",
                    "token_endpoint": f"{state.issuer}/token",
                    "jwks_uri": f"{state.issuer}/jwks",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "id_token_signing_alg_values_supported": ["RS256"],
                    "scopes_supported": ["openid", "profile", "email", "offline_access"],
                })
            elif url.path == "/jwks":
                with state.lock:
                    self.send_json(200, {"keys": [state.key.as_dict(private=False)]})
            elif url.path == "/authorize":
                self.authorize(query)
            elif url.path == "/_test/revocation":
                with state.lock:
                    self.send_json(200, {"revoked_through_gen": state.revoked_through_gen})
            elif url.path == "/_test/state":
                with state.lock:
                    self.send_json(200, state.snapshot())
            else:
                self.send_json(404, {"error": "not_found", "path": url.path})

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            if path == "/token":
                self.token(self.form())
            elif path == "/authorize/approve":
                self.approve(self.form())
            elif path.startswith("/_test/"):
                self.control(path.removeprefix("/_test/"))
            else:
                self.send_json(404, {"error": "not_found", "path": path})

        # -- authorize -------------------------------------------------------

        def authorize(self, q: dict[str, str]) -> None:
            problems = []
            if q.get("response_type") != "code":
                problems.append("response_type must be code")
            if q.get("client_id") != state.client_id:
                problems.append(f"unknown client_id {q.get('client_id')!r}")
            if not q.get("redirect_uri"):
                problems.append("redirect_uri missing")
            if q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
                problems.append("PKCE S256 code_challenge required")
            if problems:
                with state.lock:
                    state.event("authorize_rejected", problems=problems)
                self.send_html(400, "<h1>Bad authorize request</h1><ul>" + "".join(f"<li>{p}</li>" for p in problems) + "</ul>")
                return
            with state.lock:
                mode = state.config["authorize_mode"]
                delay = float(state.config["authorize_delay"])
                state.event("authorize", mode=mode, delay=delay, redirect_uri=q["redirect_uri"],
                            prompt=q.get("prompt"), scope=q.get("scope"))
            if mode == "button":
                fields = "".join(
                    f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(v)}">' for k, v in q.items()
                )
                self.send_html(200, f"""<!doctype html><meta charset="utf-8"><title>Fake IdP sign-in</title>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto">
<h1>Fake IdP</h1><p>Sign in as <b>{html.escape(str(state.config['sub']))}</b>?</p>
<form method="post" action="/authorize/approve">{fields}
<button name="decision" value="approve" data-testid="fake-idp-approve">Sign in</button>
<button name="decision" value="deny" data-testid="fake-idp-deny">Deny</button></form>""")
                return
            if delay > 0:
                time.sleep(delay)
            self.issue_code(q)

        def approve(self, form: dict[str, str]) -> None:
            q = {k: v for k, v in form.items() if k != "decision"}
            if form.get("decision") == "deny":
                with state.lock:
                    state.event("authorize_denied")
                self.redirect(self.callback(q["redirect_uri"], error="access_denied",
                                            error_description="The user denied the request", state=q.get("state")))
                return
            self.issue_code(q)

        @staticmethod
        def callback(redirect_uri: str, **params: str | None) -> str:
            sep = "&" if "?" in redirect_uri else "?"
            return redirect_uri + sep + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})

        def issue_code(self, q: dict[str, str]) -> None:
            code = f"code.{secrets.token_urlsafe(16)}"
            with state.lock:
                state.codes[code] = {
                    "client_id": q["client_id"],
                    "redirect_uri": q["redirect_uri"],
                    "code_challenge": q["code_challenge"],
                    "scope": q.get("scope") or "openid",
                    "created": time.time(),
                }
                state.event("code_issued", redirect_uri=q["redirect_uri"])
            self.redirect(self.callback(q["redirect_uri"], code=code, state=q.get("state")))

        # -- token -----------------------------------------------------------

        def token(self, f: dict[str, str]) -> None:
            grant = f.get("grant_type")
            if f.get("client_id") != state.client_id:
                self.token_error(401, "invalid_client", f"unknown client_id {f.get('client_id')!r}", grant)
                return
            if grant == "authorization_code":
                self.code_grant(f)
            elif grant == "refresh_token":
                self.refresh_grant(f)
            else:
                self.token_error(400, "unsupported_grant_type", f"grant_type {grant!r}", grant)

        def token_error(self, status: int, error: str, description: str, grant: str | None) -> None:
            with state.lock:
                state.event("token_error", grant=grant, error=error, description=description)
            self.send_json(status, {"error": error, "error_description": description})

        def code_grant(self, f: dict[str, str]) -> None:
            with state.lock:
                record = state.codes.pop(f.get("code", ""), None)
            if record is None:
                self.token_error(400, "invalid_grant", "AADSTS54005: The authorization code is unknown or was already redeemed.", "authorization_code")
                return
            if time.time() - record["created"] > 600:
                self.token_error(400, "invalid_grant", "AADSTS70008: The authorization code has expired.", "authorization_code")
                return
            if f.get("redirect_uri") != record["redirect_uri"]:
                self.token_error(400, "invalid_grant", "AADSTS50148: redirect_uri does not match the authorize request.", "authorization_code")
                return
            if s256(f.get("code_verifier", "")) != record["code_challenge"]:
                self.token_error(400, "invalid_grant", "AADSTS501481: The code_verifier does not match the code_challenge.", "authorization_code")
                return
            with state.lock:
                now = int(time.time())
                sid = f"s{len(state.sessions) + 1}"
                state.sessions[sid] = {
                    "sub": state.config["sub"],
                    "email": state.config["email"],
                    "name": state.config["name"],
                    "created": now,
                    "refresh_expires_at": now + int(state.config["refresh_lifetime"]),
                    "origin": self.headers.get("Origin"),
                }
                state.event("sign_in", sid=sid, origin=self.headers.get("Origin"))
                body = state.mint(sid, record["scope"], "authorization_code")
            self.send_json(200, body)

        def refresh_grant(self, f: dict[str, str]) -> None:
            with state.lock:
                sid = state.refresh_tokens.get(f.get("refresh_token", ""))
                session = state.sessions.get(sid) if sid else None
                expired = session is not None and session["refresh_expires_at"] <= time.time()
                lifetime = f"{int(state.config['refresh_lifetime'])} seconds"
                if session is not None and not expired:
                    state.event("refresh", sid=sid, origin=self.headers.get("Origin"))
                    body = state.mint(sid, f.get("scope") or "openid", "refresh_token")
            if session is None:
                self.token_error(400, "invalid_grant", "AADSTS9002313: The refresh token is unknown.", "refresh_token")
            elif expired:
                self.token_error(400, "invalid_grant", AADSTS700084.format(lifetime=lifetime), "refresh_token")
            else:
                self.send_json(200, body)

        # -- control ---------------------------------------------------------

        def control(self, action: str) -> None:
            with state.lock:
                if action == "config":
                    updates = self.json_body()
                    unknown = sorted(set(updates) - set(DEFAULT_CONFIG))
                    if unknown:
                        self.send_json(400, {"error": f"unknown config keys: {unknown}"})
                        return
                    state.config.update(updates)
                    state.event("config", **updates)
                elif action == "expire-refresh":
                    now = int(time.time())
                    for session in state.sessions.values():
                        session["refresh_expires_at"] = min(session["refresh_expires_at"], now)
                    state.event("expire_refresh", sessions=len(state.sessions))
                elif action == "revoke-access":
                    state.revoked_through_gen = state.gen
                    state.event("revoke_access", through_gen=state.gen)
                elif action == "expire-all":
                    now = int(time.time())
                    for session in state.sessions.values():
                        session["refresh_expires_at"] = min(session["refresh_expires_at"], now)
                    state.revoked_through_gen = state.gen
                    state.event("expire_all", sessions=len(state.sessions), through_gen=state.gen)
                elif action == "reset":
                    state.reset()
                    state.event("reset")
                else:
                    self.send_json(404, {"error": f"unknown control action {action!r}"})
                    return
                snapshot = state.snapshot()
            self.send_json(200, snapshot)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9019)
    parser.add_argument("--issuer", help="issuer URL (default http://localhost:<port>)")
    parser.add_argument("--client-id", default="cupola-test-client")
    args = parser.parse_args()
    issuer = (args.issuer or f"http://localhost:{args.port}").rstrip("/")
    state = State(issuer, args.client_id)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    server.daemon_threads = True
    print(f"Fake IdP {issuer} (client_id {args.client_id}) on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
