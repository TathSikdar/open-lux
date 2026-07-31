/**********************
 * open-lux ambient light meter
 *
 * Reports the raw LDR ADC reading (0-1023) once a second, only when it has
 * moved. All interpretation -- lux conversion, response curve, per-display
 * calibration -- lives on the PC side so none of it needs a reflash.
 *
 * Wiring: LDR and fixed resistor as a divider into SENSOR_PIN.
 * See docs/schematics.png.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Tath Sikdar
 **********************/

const int SENSOR_PIN = A7;       // <-- set to the pin your LDR divider feeds
const int SAMPLES = 32;          // ADC noise averaging, ~4ms total
const int CHANGE_THRESHOLD = 1;  // ADC counts; 0 = report every second regardless

int lastSent = -999;

void setup() {
  Serial.begin(9600);
}

void loop() {
  long sum = 0;
  for (int i = 0; i < SAMPLES; i++) sum += analogRead(SENSOR_PIN);
  int reading = sum / SAMPLES;

  if (abs(reading - lastSent) >= CHANGE_THRESHOLD) {
    Serial.println(reading);
    lastSent = reading;
  }
  delay(1000);
}
