"""Invite delivery seam. No SMTP infrastructure yet: invites are minted by the
admin UI, which shows the returned URL for copy-paste. When real email arrives,
implement send_invite here — the orgs router already calls it."""
import logging

log = logging.getLogger("uvicorn.error")


def send_invite(email: str, invite_url: str) -> None:
    log.info("Invite for %s (not emailed — copy the link from the admin UI): %s",
             email, invite_url)
