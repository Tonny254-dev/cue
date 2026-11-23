"""
Fluid profiles for multi-liquid pipe monitoring.

Research basis (turbine / hall-effect volumetric meters):
- K-factor (pulses per litre) is fluid- and meter-specific; viscosity and density
  shift the effective calibration outside the high-Re "viscosity-independent" band
  (NIST turbine meter work; industrial UVC practice).
- Differential leak detection (Qin − Qout) is fluid-agnostic *if* both sensors
  report calibrated volumetric L/min for the same fluid.
- Multiphase (liquid + free gas), reverse flow without a bidirectional meter,
  and chemically incompatible sensors are OUT OF GUARANTEE — flagged below.

Software guarantee: with a compatible single-phase sensor pair, correct K-factor,
and both ends reporting, the CUE algorithm behaves the same for every fluid class.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any


@dataclass(frozen=True)
class FluidProfile:
    code: str
    label: str
    # Nominal YF-S201-class water K-factor; override per meter datasheet.
    k_factor: Decimal
    viscosity_class: str  # LOW | MEDIUM | HIGH
    density_kg_m3: Decimal
    flow_noise_lpm: Decimal
    min_flow_arm_lpm: Decimal
    # Recommended meter families for this fluid (documentation / UI).
    recommended_sensors: tuple[str, ...]
    # Hard limits of the guarantee.
    compatible_with_yf_s201: bool
    single_phase_only: bool
    notes: str

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["k_factor"] = str(self.k_factor)
        d["density_kg_m3"] = str(self.density_kg_m3)
        d["flow_noise_lpm"] = str(self.flow_noise_lpm)
        d["min_flow_arm_lpm"] = str(self.min_flow_arm_lpm)
        d["recommended_sensors"] = list(self.recommended_sensors)
        return d


FLUID_PROFILES: dict[str, FluidProfile] = {
    "WATER": FluidProfile(
        code="WATER",
        label="Water (potable / irrigation)",
        k_factor=Decimal("7.5"),
        viscosity_class="LOW",
        density_kg_m3=Decimal("998"),
        flow_noise_lpm=Decimal("0.40"),
        min_flow_arm_lpm=Decimal("2.0"),
        recommended_sensors=("YF-S201", "YF-S401", "ultrasonic_clamp"),
        compatible_with_yf_s201=True,
        single_phase_only=True,
        notes="Default kit profile. Hall turbine meters are rated for clean water.",
    ),
    "DIESEL": FluidProfile(
        code="DIESEL",
        label="Diesel / light fuel",
        k_factor=Decimal("7.5"),  # replace with meter datasheet K after install
        viscosity_class="LOW",
        density_kg_m3=Decimal("830"),
        flow_noise_lpm=Decimal("0.50"),
        min_flow_arm_lpm=Decimal("2.2"),
        recommended_sensors=("oval_gear", "turbine_fuel", "ultrasonic_clamp"),
        compatible_with_yf_s201=False,
        single_phase_only=True,
        notes="Use fuel-rated meters; YF-S201 plastic/hall bodies are not fuel-safe.",
    ),
    "OIL_LIGHT": FluidProfile(
        code="OIL_LIGHT",
        label="Light oil / hydraulic",
        k_factor=Decimal("7.0"),
        viscosity_class="MEDIUM",
        density_kg_m3=Decimal("870"),
        flow_noise_lpm=Decimal("0.60"),
        min_flow_arm_lpm=Decimal("2.5"),
        recommended_sensors=("oval_gear", "positive_displacement", "coriolis"),
        compatible_with_yf_s201=False,
        single_phase_only=True,
        notes="Viscosity raises bearing drag; calibrate K at operating temperature.",
    ),
    "OIL_HEAVY": FluidProfile(
        code="OIL_HEAVY",
        label="Heavy / viscous oil",
        k_factor=Decimal("6.0"),
        viscosity_class="HIGH",
        density_kg_m3=Decimal("920"),
        flow_noise_lpm=Decimal("0.80"),
        min_flow_arm_lpm=Decimal("3.0"),
        recommended_sensors=("positive_displacement", "coriolis"),
        compatible_with_yf_s201=False,
        single_phase_only=True,
        notes="Low-Re regime: turbine meters under-read without UVC/temp compensation.",
    ),
    "CHEMICAL_AQUEOUS": FluidProfile(
        code="CHEMICAL_AQUEOUS",
        label="Aqueous chemical / process",
        k_factor=Decimal("7.5"),
        viscosity_class="LOW",
        density_kg_m3=Decimal("1050"),
        flow_noise_lpm=Decimal("0.45"),
        min_flow_arm_lpm=Decimal("2.0"),
        recommended_sensors=("ultrasonic_clamp", "magmeter", "PTFE_turbine"),
        compatible_with_yf_s201=False,
        single_phase_only=True,
        notes="Material compatibility (seals/body) is mandatory; density may need K tweak.",
    ),
    "PROCESS_GENERIC": FluidProfile(
        code="PROCESS_GENERIC",
        label="Generic process liquid",
        k_factor=Decimal("7.5"),
        viscosity_class="MEDIUM",
        density_kg_m3=Decimal("1000"),
        flow_noise_lpm=Decimal("0.55"),
        min_flow_arm_lpm=Decimal("2.3"),
        recommended_sensors=("ultrasonic_clamp", "coriolis", "turbine_industrial"),
        compatible_with_yf_s201=False,
        single_phase_only=True,
        notes="Set K-factor from the installed meter datasheet after commissioning.",
    ),
}

DEFAULT_FLUID = "WATER"


def get_fluid_profile(code: str | None) -> FluidProfile:
    if not code:
        return FLUID_PROFILES[DEFAULT_FLUID]
    return FLUID_PROFILES.get(str(code).upper(), FLUID_PROFILES[DEFAULT_FLUID])


def list_fluid_profiles() -> list[dict[str, Any]]:
    return [p.as_dict() for p in FLUID_PROFILES.values()]


def apply_profile_to_thresholds(code: str | None) -> dict[str, Decimal]:
    p = get_fluid_profile(code)
    return {
        "k_factor": p.k_factor,
        "flow_noise_lpm": p.flow_noise_lpm,
        "min_flow_arm_lpm": p.min_flow_arm_lpm,
        "viscosity_class": p.viscosity_class,
    }


# Explicit non-guarantees (surfaced in API / About / simulator).
OUT_OF_GUARANTEE = [
    {
        "id": "multiphase",
        "title": "Multiphase / free gas",
        "detail": "Oil+gas or aerated lines need multiphase metering; CUE assumes single-phase liquid.",
    },
    {
        "id": "wrong_sensor_material",
        "title": "Incompatible sensor material",
        "detail": "YF-S201-class water meters must not be used on fuel/aggressive chemicals.",
    },
    {
        "id": "uncalibrated_k",
        "title": "Uncalibrated K-factor",
        "detail": "Wrong pulses/L makes absolute L/min wrong; differential still works if both ends match.",
    },
    {
        "id": "single_sensor",
        "title": "One sensor offline",
        "detail": "Leak locus requires both inlet and outlet. System reports sensor fault, not a false leak.",
    },
    {
        "id": "dry_pipe_noise",
        "title": "Dry pipe / below arm threshold",
        "detail": "Below min_flow_arm_lpm the leak detector stays disarmed to avoid chatter.",
    },
]
