"""
limiter.py — Shared slowapi Limiter instance.

Defined here (not in main.py) so route files can import it without circular imports.
main.py registers it on app.state; route decorators use it directly.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
