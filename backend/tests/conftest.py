"""The suite exercises data endpoints, not authentication: run with the auth
bridge on (synthetic superuser, org 1) so TestClient needs no cookies/headers.
Auth/permission behavior itself is exercised end-to-end, not here."""
import os

os.environ.setdefault("SAPCHE_AUTH_DISABLED", "1")
