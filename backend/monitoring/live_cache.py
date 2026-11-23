"""In-process live snapshot so /monitoring/live/ avoids heavy DB work on every poll."""

from __future__ import annotations

from typing import Any

from django.core.cache import cache

PRIMARY_KEY = "cue:live:primary"


def live_key(pipeline_id: int | None) -> str:
    if pipeline_id:
        return f"cue:live:{pipeline_id}"
    return PRIMARY_KEY


def set_live_snapshot(pipeline_id: int | None, payload: dict[str, Any], ttl: int = 60) -> None:
    cache.set(live_key(pipeline_id), payload, ttl)
    cache.set(PRIMARY_KEY, payload, ttl)


def get_live_snapshot(pipeline_id: int | None = None) -> dict[str, Any] | None:
    data = cache.get(live_key(pipeline_id))
    if data is None and pipeline_id is None:
        return None
    if data is None:
        return cache.get(PRIMARY_KEY)
    return data
