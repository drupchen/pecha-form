#!/usr/bin/env python
"""Reset a local user's password directly in sapche.db.

Local dev recovery only: the /auth/password endpoint requires the current
password, so a forgotten one can only be replaced by rewriting the argon2id
hash here. Run it with the backend venv:

    .venv/bin/python reset_password.py [email]

The password is read with getpass (never echoed, never passed as an argument).
"""
import getpass
import sqlite3
import sys
from pathlib import Path

from argon2 import PasswordHasher

DB = Path(__file__).resolve().parent / "sapche.db"


def main() -> int:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        if len(sys.argv) > 1:
            email = sys.argv[1]
        else:
            rows = conn.execute("SELECT email FROM users ORDER BY id").fetchall()
            if len(rows) != 1:
                print("Pass the email explicitly; users are: "
                      + ", ".join(r["email"] for r in rows))
                return 1
            email = rows[0]["email"]

        user = conn.execute("SELECT id, email, display_name FROM users "
                            "WHERE email = ?", (email,)).fetchone()
        if user is None:
            print(f"No user with email {email!r}")
            return 1

        print(f"Resetting password for {user['display_name']} <{user['email']}>")
        pw = getpass.getpass("New password: ")
        if not pw:
            print("Empty password, aborted.")
            return 1
        if pw != getpass.getpass("Repeat: "):
            print("Passwords do not match, aborted.")
            return 1

        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                     (PasswordHasher().hash(pw), user["id"]))
        killed = conn.execute("DELETE FROM sessions WHERE user_id = ?",
                              (user["id"],)).rowcount
        conn.commit()
        print(f"Done — password updated, {killed} existing session(s) signed out.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
