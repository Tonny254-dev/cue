"""Display helpers: L/min + L, or mL/min + mL when small. Noise gate for dry pipe."""

from __future__ import annotations

# Below this = sensor chatter / dry pipe — treat as zero (no volume accumulate).
FLOW_NOISE_LPM = 0.40
# Show mL when below these thresholds.
FLOW_ML_BELOW_LPM = 1.0
VOL_ML_BELOW_L = 1.0


def gate_flow_lpm(lpm: float) -> float:
    v = float(lpm or 0.0)
    if v < 0:
        v = 0.0
    if v < FLOW_NOISE_LPM:
        return 0.0
    return v


def format_flow(lpm: float) -> dict:
    """Return display value for flow rate."""
    v = gate_flow_lpm(lpm)
    if v <= 0:
        return {"value": 0.0, "unit": "mL/min", "text": "0 mL/min", "lpm": 0.0, "flowing": False}
    if v < FLOW_ML_BELOW_LPM:
        mlpm = round(v * 1000.0, 0)
        return {
            "value": mlpm,
            "unit": "mL/min",
            "text": f"{mlpm:.0f} mL/min",
            "lpm": round(v, 3),
            "flowing": True,
        }
    return {
        "value": round(v, 2),
        "unit": "L/min",
        "text": f"{v:.2f} L/min",
        "lpm": round(v, 2),
        "flowing": True,
    }


def format_volume(liters: float) -> dict:
    v = max(float(liters or 0.0), 0.0)
    if v < VOL_ML_BELOW_L:
        ml = round(v * 1000.0, 0)
        return {"value": ml, "unit": "mL", "text": f"{ml:.0f} mL", "liters": round(v, 4)}
    return {"value": round(v, 2), "unit": "L", "text": f"{v:.2f} L", "liters": round(v, 2)}


def pressure_proxy(inlet_lpm: float, outlet_lpm: float) -> dict:
    """
    No pressure transducer on the kit — use flow balance as a pressure-drop proxy.
    100% = balanced (Qin≈Qout). Lower = more drop / possible leak.
    """
    qin = gate_flow_lpm(inlet_lpm)
    qout = gate_flow_lpm(outlet_lpm)
    if qin <= 0 and qout <= 0:
        return {
            "available": False,
            "balance_pct": None,
            "drop_proxy_pct": None,
            "summary": "No flow — pipe dry / idle (not measuring pressure yet)",
        }
    if qin <= 0:
        return {
            "available": False,
            "balance_pct": None,
            "drop_proxy_pct": None,
            "summary": "No inlet flow measured",
        }
    bal = min(200.0, max(0.0, (qout / qin) * 100.0))
    drop = max(0.0, 100.0 - bal)
    return {
        "available": True,
        "balance_pct": round(bal, 1),
        "drop_proxy_pct": round(drop, 1),
        "qin_lpm": round(qin, 3),
        "qout_lpm": round(qout, 3),
        "summary": (
            f"Flow balance {bal:.0f}% (drop proxy {drop:.0f}%). "
            "Derived from S1/S2 flow — not a PSI sensor."
        ),
    }
