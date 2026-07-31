/**********************
 * open-lux ambient light meter
 *
 * Reports an oversampled LDR reading ten times a second. All interpretation --
 * lux conversion, response curve, per-display calibration -- lives on the PC
 * side so none of it needs a reflash.
 *
 * The reading is sent with decimals on purpose. The ADC is 10-bit, but the LDR
 * divider always carries at least a count or two of noise, so averaging N
 * samples dithers out to roughly log4(N) extra bits: 128 samples is about 3.5
 * bits, which is the difference between "0, 1, 2" and a usable curve in a dim
 * room. Truncating the average back to an int throws all of that away.
 *
 * Wiring: LDR and fixed resistor as a divider into SENSOR_PIN.
 * See docs/schematics.png.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Tath Sikdar
 **********************/

const int SENSOR_PIN = A7;             // <-- set to the pin your LDR divider feeds
const int SAMPLES = 128;               // oversampling; ~14ms of analogRead
const unsigned long PERIOD_MS = 100;   // 10 Hz, so the PC is never a second behind
const int DECIMALS = 2;

void setup() {
  Serial.begin(9600);
  analogRead(SENSOR_PIN);  // first conversion after a mux change is unreliable
}

void loop() {
  const unsigned long started = millis();

  unsigned long sum = 0;
  for (int i = 0; i < SAMPLES; i++) sum += analogRead(SENSOR_PIN);
  Serial.println(sum / (float)SAMPLES, DECIMALS);

  // Pace on elapsed time, not a fixed delay: the sampling loop is a sizeable
  // and board-dependent slice of the period.
  const unsigned long spent = millis() - started;
  if (spent < PERIOD_MS) delay(PERIOD_MS - spent);
}
