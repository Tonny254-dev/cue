"""Accumulate short windows and store mean flow / pulse volume history."""

from __future__ import annotations

from iot.models import FlowHistoryMean

_WINDOW = 10  # samples (~10 s while flowing)
_buf_in: list[float] = []
_buf_out: list[float] = []
_buf_loss: list[float] = []
_vol_in_ml = 0.0
_vol_out_ml = 0.0


def reset_window() -> None:
    global _buf_in, _buf_out, _buf_loss, _vol_in_ml, _vol_out_ml
    _buf_in = []
    _buf_out = []
    _buf_loss = []
    _vol_in_ml = 0.0
    _vol_out_ml = 0.0


def record_sample(
    inlet_lpm: float,
    outlet_lpm: float,
    *,
    delta_in_ml: float = 0.0,
    delta_out_ml: float = 0.0,
) -> FlowHistoryMean | None:
    """Add one flowing sample; flush a history mean every _WINDOW samples."""
    global _vol_in_ml, _vol_out_ml

    _buf_in.append(float(inlet_lpm))
    _buf_out.append(float(outlet_lpm))
    _buf_loss.append(max(float(inlet_lpm) - float(outlet_lpm), 0.0))
    _vol_in_ml += max(float(delta_in_ml), 0.0)
    _vol_out_ml += max(float(delta_out_ml), 0.0)

    if len(_buf_in) < _WINDOW:
        return None

    n = len(_buf_in)
    row = FlowHistoryMean.objects.create(
        window_sec=_WINDOW,
        sample_count=n,
        mean_inlet_lpm=sum(_buf_in) / n,
        mean_outlet_lpm=sum(_buf_out) / n,
        mean_loss_lpm=sum(_buf_loss) / n,
        volume_in_ml=_vol_in_ml,
        volume_out_ml=_vol_out_ml,
        volume_lost_ml=max(_vol_in_ml - _vol_out_ml, 0.0),
    )
    # Keep table bounded
    ids = list(
        FlowHistoryMean.objects.order_by("-recorded_at").values_list("id", flat=True)[200:]
    )
    if ids:
        FlowHistoryMean.objects.filter(id__in=ids).delete()
    reset_window()
    return row
