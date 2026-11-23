#include <Arduino.h>
#include <math.h>

// Pins
const int sensor1Pin = 2;     // Inlet S1 signal (interrupt)
const int sensor2Pin = 3;     // Outlet S2 signal (interrupt)
const int relayPin = 4;
const int sensor1Power = 10;  // 5V enable for S1 (YF-S201 red)
const int sensor2Power = 11;  // 5V enable for S2
const int relayPower = 12;

// YF-S201: L/min = pulse_Hz / 7.5. Volume from pulses only (not from smoothed L/min).
const float PULSES_PER_LITRE_PER_SEC = 7.5;  // Hz per (L/min)
const float ML_PER_PULSE = 1000.0 / (7.5 * 60.0);  // ≈ 2.222 mL per pulse
const int MIN_PULSES_FOR_FLOW = 1;  // count even a single pulse in the 1s window

// ---- Pattern learning (S1 vs S2) — measured flow only ----
const float FLOW_NOISE_LPM = 0.40;   // dry-pipe chatter → report 0
const float MIN_FLOW_ARM_LPM = 2.0;
const float ABS_RESIDUAL_MIN_LPM = 1.8;
const float REL_RESIDUAL_FRAC = 0.20;
const int CONFIRM_SAMPLES = 8;
const int MIN_LEARN_SAMPLES = 20;
const float LEARN_CAP_LPM = 2.5;
const float BIAS_LEARN_ALPHA = 0.04;
const float VAR_LEARN_ALPHA = 0.05;
const float FLOW_EMA_ALPHA = 0.85;  // leak-model smoother; live UI uses instant rate
const float Z_TRIP = 2.5;
const float PIPE_LENGTH_M = 50.0;  // set to real S1→S2 length
const unsigned long SAMPLE_MS = 250;  // 4 Hz telemetry for snappy live UI

volatile unsigned int pulseCount1 = 0;
volatile unsigned int pulseCount2 = 0;

float flowRate1 = 0.0;
float flowRate2 = 0.0;
float smooth1 = 0.0;
float smooth2 = 0.0;
float sensorBias = 0.0;
float residualMean = 0.0;
float residualVar = 0.25;
int learnSamples = 0;
int leakConfirmCount = 0;
bool patternReady = false;
bool sawInlet = false;
bool sawOutlet = false;

unsigned long oldTime = 0;
bool systemLocked = false;
String serialBuffer = "";

void pulseCounter1() { pulseCount1++; }
void pulseCounter2() { pulseCount2++; }

float requiredResidual(float inletLpm) {
  float rel = inletLpm * REL_RESIDUAL_FRAC;
  return (rel > ABS_RESIDUAL_MIN_LPM) ? rel : ABS_RESIDUAL_MIN_LPM;
}

float residualStdev() {
  float v = residualVar;
  if (v < 0.04) {
    v = 0.04;
  }
  return sqrt(v);
}

// Coarse band only — no fake millimetre/millilitre precision.
// Returns band code: 1=near S1, 2=mid, 3=near S2. Fills metre mid + severity.
int estimateBand(float inletLpm, float residual, float *fromS1, float *fromS2, float *severityPct) {
  float sev = 0.0;
  if (inletLpm > 0.01) {
    sev = residual / inletLpm;
  }
  if (sev < 0.0) sev = 0.0;
  if (sev > 1.0) sev = 1.0;
  *severityPct = sev * 100.0;

  float fracLo;
  float fracHi;
  int band;
  if (sev >= 0.40) {
    band = 1;
    fracLo = 0.05;
    fracHi = 0.35;
  } else if (sev >= 0.18) {
    band = 2;
    fracLo = 0.30;
    fracHi = 0.70;
  } else {
    band = 3;
    fracLo = 0.55;
    fracHi = 0.95;
  }
  float mid = 0.5 * (fracLo + fracHi);
  *fromS1 = PIPE_LENGTH_M * mid;
  *fromS2 = PIPE_LENGTH_M - *fromS1;
  return band;
}

void openValveAndMonitor() {
  systemLocked = false;
  leakConfirmCount = 0;
  noInterrupts();
  pulseCount1 = 0;
  pulseCount2 = 0;
  interrupts();
  flowRate1 = 0.0;
  flowRate2 = 0.0;
  smooth1 = 0.0;
  smooth2 = 0.0;
  sawInlet = false;
  sawOutlet = false;
  oldTime = millis();
  digitalWrite(relayPin, HIGH);
  Serial.println("System Active: Water Valve OPEN. Learning S1/S2 pattern...");
}

void handleHostCommand(const String &cmd) {
  String c = cmd;
  c.trim();
  c.toUpperCase();

  if (c == "RESET" || c == "RESTART" || c == "UNLOCK") {
    openValveAndMonitor();
    Serial.println("ACK:RESET");
  } else if (c == "CALIBRATE" || c == "ZERO_BIAS") {
    // Pattern wipe disabled — keep improving the learned S1/S2 model.
    Serial.println("ACK:CALIBRATE_IGNORED");
    Serial.println("AI: pattern kept (continuous learning)");
  } else if (c == "STATUS") {
    Serial.print("STATUS:");
    Serial.print(systemLocked ? "LOCKED" : (patternReady ? "MONITORING" : "LEARNING"));
    Serial.print(":IN=");
    Serial.print(smooth1, 2);
    Serial.print(":OUT=");
    Serial.print(smooth2, 2);
    Serial.print(":BIAS=");
    Serial.print(sensorBias, 2);
    Serial.print(":LEARN=");
    Serial.print(learnSamples);
    Serial.print(":CONF=");
    Serial.println(leakConfirmCount);
  } else if (c == "CLOSE") {
    systemLocked = true;
    digitalWrite(relayPin, LOW);
    Serial.println("ACK:VALVE_CLOSED");
  }
}

void pollSerialCommands() {
  while (Serial.available() > 0) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (serialBuffer.length() > 0) {
        handleHostCommand(serialBuffer);
        serialBuffer = "";
      }
    } else if (serialBuffer.length() < 48) {
      serialBuffer += ch;
    }
  }
}

void setup() {
  Serial.begin(9600);

  pinMode(sensor1Power, OUTPUT);
  digitalWrite(sensor1Power, HIGH);
  pinMode(sensor2Power, OUTPUT);
  digitalWrite(sensor2Power, HIGH);
  pinMode(relayPower, OUTPUT);
  digitalWrite(relayPower, HIGH);

  // YF-S201 / clones: open-collector signal. Prefer external sensor pull-up;
  // ENABLE internal pull-up as backup so floating lines still edge-detect.
  pinMode(sensor1Pin, INPUT_PULLUP);
  pinMode(sensor2Pin, INPUT_PULLUP);
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, HIGH);

  // FALLING = one count per rotor tooth (CHANGE inflated L/min ~2x on many clones).
  attachInterrupt(digitalPinToInterrupt(sensor1Pin), pulseCounter1, FALLING);
  attachInterrupt(digitalPinToInterrupt(sensor2Pin), pulseCounter2, FALLING);

  Serial.println("CUE firmware: D2/D3 FALLING, 250ms sample, S2 power D11");
  openValveAndMonitor();
}

void loop() {
  pollSerialCommands();

  if ((millis() - oldTime) < SAMPLE_MS || systemLocked) {
    return;
  }

  // Short window from pulse counts → L/min (scaled by elapsedSec).
  unsigned long now = millis();
  float elapsedSec = (now - oldTime) / 1000.0;
  if (elapsedSec < 0.12) {
    return;
  }

  noInterrupts();
  unsigned int p1 = pulseCount1;
  unsigned int p2 = pulseCount2;
  pulseCount1 = 0;
  pulseCount2 = 0;
  interrupts();

  // Instantaneous L/min from this window's pulses only.
  flowRate1 = (p1 / elapsedSec) / PULSES_PER_LITRE_PER_SEC;
  flowRate2 = (p2 / elapsedSec) / PULSES_PER_LITRE_PER_SEC;

  // Exact volume this second from pulse count (honest mL) — not from EMA.
  float dMl1 = 0.0;
  float dMl2 = 0.0;
  if (p1 >= (unsigned int)MIN_PULSES_FOR_FLOW) {
    dMl1 = p1 * ML_PER_PULSE;
  } else {
    flowRate1 = 0.0;
  }
  if (p2 >= (unsigned int)MIN_PULSES_FOR_FLOW) {
    dMl2 = p2 * ML_PER_PULSE;
  } else {
    flowRate2 = 0.0;
  }

  if (flowRate1 <= 0.0) {
    smooth1 = 0.0;  // no EMA bleed when dry
  } else {
    smooth1 = (FLOW_EMA_ALPHA * flowRate1) + ((1.0 - FLOW_EMA_ALPHA) * smooth1);
  }
  if (flowRate2 <= 0.0) {
    smooth2 = 0.0;
  } else {
    smooth2 = (FLOW_EMA_ALPHA * flowRate2) + ((1.0 - FLOW_EMA_ALPHA) * smooth2);
  }

  if (smooth1 < FLOW_NOISE_LPM) {
    smooth1 = 0.0;
  }
  if (smooth2 < FLOW_NOISE_LPM) {
    smooth2 = 0.0;
  }

  if (smooth1 >= FLOW_NOISE_LPM) {
    sawInlet = true;
  }
  if (smooth2 >= FLOW_NOISE_LPM) {
    sawOutlet = true;
  }

  float rawDq = smooth1 - smooth2;
  float residual = rawDq - sensorBias;
  float expectedOut = smooth1 - sensorBias;
  if (expectedOut < 0.0) {
    expectedOut = 0.0;
  }
  float need = requiredResidual(smooth1);
  float stdev = residualStdev();

  bool bothMeasured = sawInlet && sawOutlet;
  bool healthyPair =
      smooth1 >= MIN_FLOW_ARM_LPM &&
      smooth2 >= 0.3 &&
      fabs(rawDq) <= LEARN_CAP_LPM &&
      residual < ABS_RESIDUAL_MIN_LPM;

  if (bothMeasured && healthyPair) {
    sensorBias = (BIAS_LEARN_ALPHA * rawDq) + ((1.0 - BIAS_LEARN_ALPHA) * sensorBias);
    residualMean = (VAR_LEARN_ALPHA * residual) + ((1.0 - VAR_LEARN_ALPHA) * residualMean);
    float err = residual - residualMean;
    residualVar = (VAR_LEARN_ALPHA * err * err) + ((1.0 - VAR_LEARN_ALPHA) * residualVar);
    if (learnSamples < 30000) {
      learnSamples++;
    }
    if (!patternReady && learnSamples >= MIN_LEARN_SAMPLES) {
      patternReady = true;
      Serial.print("AI: pattern ready after ");
      Serial.print(learnSamples);
      Serial.println(" healthy S1/S2 samples");
    }
  }

  float balancePct = 100.0;
  if (smooth1 >= 0.2) {
    balancePct = (smooth2 / smooth1) * 100.0;
    if (balancePct > 200.0) balancePct = 200.0;
    if (balancePct < 0.0) balancePct = 0.0;
  }

  // Live telemetry uses instantaneous window rate (not EMA) so the UI feels instant.
  float show1 = flowRate1;
  float show2 = flowRate2;
  if (show1 < FLOW_NOISE_LPM) show1 = 0.0;
  if (show2 < FLOW_NOISE_LPM) show2 = 0.0;

  // Telemetry: L/min + pulse-true dV in mL (backend must use dV, not L/min integrate).
  Serial.print("Inlet (S1): ");
  Serial.print(show1, 2);
  Serial.print(" L/min  |  Outlet (S2): ");
  Serial.print(show2, 2);
  Serial.print(" L/min  |  dV_in:");
  Serial.print(dMl1, 1);
  Serial.print("mL dV_out:");
  Serial.print(dMl2, 1);
  Serial.print("mL pulses:");
  Serial.print(p1);
  Serial.print("/");
  Serial.print(p2);
  Serial.print(" pins:D2=");
  Serial.print(digitalRead(sensor1Pin));
  Serial.print(" D3=");
  Serial.print(digitalRead(sensor2Pin));
  Serial.print(" | exp: ");
  Serial.print(expectedOut, 2);
  Serial.print("  bias: ");
  Serial.print(sensorBias, 2);
  Serial.print("  res: ");
  Serial.print(residual, 2);
  Serial.print(" (need ");
  Serial.print(need, 2);
  Serial.print(") bal: ");
  Serial.print(balancePct, 0);
  Serial.print("% learn ");
  Serial.print(learnSamples);
  Serial.print("/");
  Serial.print(MIN_LEARN_SAMPLES);
  Serial.print(patternReady ? " READY" : " TRAIN");
  Serial.print(" conf ");
  Serial.print(leakConfirmCount);
  Serial.print("/");
  Serial.println(CONFIRM_SAMPLES);

  bool candidate = false;
  if (patternReady && bothMeasured && smooth1 >= MIN_FLOW_ARM_LPM) {
    float z = (residual - residualMean) / stdev;
    if (residual >= need && z >= Z_TRIP) {
      candidate = true;
    }
  }

  if (candidate) {
    leakConfirmCount++;
    Serial.print("AI: watch consistency ");
    Serial.print(leakConfirmCount);
    Serial.print("/");
    Serial.print(CONFIRM_SAMPLES);
    Serial.print(" measured loss ");
    Serial.print(residual > 0.0 ? residual : 0.0, 2);
    Serial.println(" L/min");

    if (leakConfirmCount >= CONFIRM_SAMPLES) {
      systemLocked = true;
      digitalWrite(relayPin, LOW);

      float fromS1 = 0.0;
      float fromS2 = 0.0;
      float sevPct = 0.0;
      float useRes = residual > 0.0 ? residual : 0.0;
      int band = estimateBand(smooth1, useRes, &fromS1, &fromS2, &sevPct);

      Serial.print("LEAK_ALERT:ZONE_1:");
      Serial.print(smooth1, 2);
      Serial.print(":");
      Serial.println(smooth2, 2);
      Serial.println("ACTION: Relay OFF -> Valve CLOSED");
      // ESTIMATE:s1_m:s2_m:sev:length:loss:qin:qout:band
      Serial.print("ESTIMATE:");
      Serial.print(fromS1, 0);
      Serial.print(":");
      Serial.print(fromS2, 0);
      Serial.print(":");
      Serial.print(sevPct, 0);
      Serial.print(":");
      Serial.print(PIPE_LENGTH_M, 0);
      Serial.print(":");
      Serial.print(useRes, 2);
      Serial.print(":");
      Serial.print(smooth1, 2);
      Serial.print(":");
      Serial.print(smooth2, 2);
      Serial.print(":");
      Serial.println(band);
      Serial.print("REPAIR: PIN ~");
      Serial.print(fromS1, 0);
      Serial.print("m from S1 / ~");
      Serial.print(fromS2, 0);
      Serial.print("m from S2 | band ");
      if (band == 1) Serial.print("near_S1");
      else if (band == 2) Serial.print("mid");
      else Serial.print("near_S2");
      Serial.print(" | loss ");
      Serial.print(useRes, 2);
      Serial.println(" L/min — inspect that section");
      Serial.print("AI: residual=");
      Serial.print(residual, 2);
      Serial.print(" z=");
      Serial.print((residual - residualMean) / stdev, 2);
      Serial.print(" bias=");
      Serial.print(sensorBias, 2);
      Serial.print(" balance=");
      Serial.print(balancePct, 0);
      Serial.println("%");
    }
  } else {
    if (leakConfirmCount > 0) {
      leakConfirmCount--;
    }
  }

  oldTime = now;
}
