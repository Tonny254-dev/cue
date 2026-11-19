"""Conservative break locus from measured S1/S2 flow only.

Rules:
- Units are L/min and L only — never invent millilitres.
- No locus unless measured loss clears a hard threshold.
- Prefer a distance BAND, not a fake pinpoint metre.
"""

from __future__ import annotations

from typing import Any


# Match firmware trip floor: absolute or 20% of Qin.
ABS_LOSS_MIN_LPM = 1.8
REL_LOSS_FRAC = 0.20
MIN_QIN_LPM = 2.0


def measured_loss_lpm(inlet_lpm: float, outlet_lpm: float) -> float:
    return max(float(inlet_lpm or 0.0) - float(outlet_lpm or 0.0), 0.0)


def loss_threshold_lpm(inlet_lpm: float) -> float:
    qin = float(inlet_lpm or 0.0)
    return max(ABS_LOSS_MIN_LPM, REL_LOSS_FRAC * qin)


def estimate_break(
    inlet_lpm: float,
    outlet_lpm: float,
    *,
    length_m: float = 50.0,
    require_significant_loss: bool = True,
) -> dict[str, Any]:
    qin = round(float(inlet_lpm or 0.0), 2)
    qout = round(float(outlet_lpm or 0.0), 2)
    loss = round(measured_loss_lpm(qin, qout), 2)
    need = round(loss_threshold_lpm(qin), 2)
    length = float(length_m) if length_m and length_m > 0 else 50.0

    base = {
        "available": False,
        "units": "L/min",
        "qin_lpm": qin,
        "qout_lpm": qout,
        "loss_lpm": loss,
        "loss_threshold_lpm": need,
        "length_m": length,
        "distance_from_s1_m": None,
        "distance_from_s2_m": None,
        "distance_from_s1_range_m": None,
        "severity_pct": round(min(100.0, (loss / max(qin, 0.01)) * 100.0), 1) if qin > 0 else 0.0,
        "band": None,
        "confidence": "none",
        "summary": "",
        "method": "Measured Qin-Qout only; metre band only if loss clears threshold",
    }

    if qin < MIN_QIN_LPM:
        base["reason"] = f"Qin {qin:.2f} L/min below {MIN_QIN_LPM:.1f} L/min - no locus"
        base["summary"] = base["reason"]
        return base

    if require_significant_loss and loss < need:
        base["reason"] = (
            f"Measured loss {loss:.2f} L/min below threshold {need:.2f} L/min - no locus claimed"
        )
        base["summary"] = base["reason"]
        return base

    severity = min(1.0, loss / max(qin, 0.01))
    # Coarse hydraulic bands (higher relative loss → nearer pressurized inlet).
    if severity >= 0.40:
        band, label, conf = "near_s1", "near inlet (S1)", "medium"
        frac_lo, frac_hi = 0.05, 0.35
    elif severity >= 0.18:
        band, label, conf = "mid", "mid-segment", "medium"
        frac_lo, frac_hi = 0.30, 0.70
    else:
        band, label, conf = "near_s2", "toward outlet (S2)", "low"
        frac_lo, frac_hi = 0.55, 0.95

    s1_lo = round(length * frac_lo, 0)
    s1_hi = round(length * frac_hi, 0)
    s1_mid = round((s1_lo + s1_hi) / 2.0, 0)
    s2_mid = round(max(length - s1_mid, 0.0), 0)

    summary = (
        f"Measured Qin {qin:.2f} L/min, Qout {qout:.2f} L/min, loss {loss:.2f} L/min. "
        f"Likely break {label}: ~{s1_lo:.0f}-{s1_hi:.0f} m from S1 "
        f"(~{max(length - s1_hi, 0):.0f}-{max(length - s1_lo, 0):.0f} m from S2) "
        f"on a {length:.0f} m run. Confidence {conf}. Units L/min only."
    )

    base.update(
        {
            "available": True,
            "reason": None,
            "band": band,
            "band_label": label,
            "confidence": conf,
            "severity_pct": round(severity * 100.0, 1),
            "distance_from_s1_m": s1_mid,
            "distance_from_s2_m": s2_mid,
            "distance_from_s1_range_m": [s1_lo, s1_hi],
            "summary": summary,
        }
    )
    return base
