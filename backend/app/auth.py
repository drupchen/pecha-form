"""Account piping.

The app currently has no user accounts — everything belongs to a single local user.
This module is the seam where per-user identity enters the request path. Endpoints that
are (or will become) user-scoped depend on ``current_user_id`` via FastAPI's
``Depends``; when real authentication lands, only this function's body changes (resolve
the user from a session/token) and every caller keeps working unchanged.
"""

# The single local user until real accounts exist. Matches
# ``reading_positions.user_id``'s DEFAULT in the schema.
LOCAL_USER_ID = 1


def current_user_id() -> int:
    """The id of the user making the request. Single local user for now."""
    return LOCAL_USER_ID
