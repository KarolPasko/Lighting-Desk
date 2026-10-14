/*
  Lighting Desk - Arduino receiver

  Listens on USB serial for lines sent by index.html:
      "<channel>,<value>\n"   channel 1-512, value 0-255
      "?\n"                   replies "LD READY <mode> <channels>"

  Pick ONE output mode below:

  MODE_PWM  - drive LEDs / MOSFET dimmers straight from the Arduino's PWM pins.
              No extra hardware or libraries. Channel 1 -> first pin in PWM_PINS, etc.

  MODE_DMX  - send real DMX512 to stage lights. Needs an RS-485 / DMX shield
              (e.g. a MAX485 module or a Tinker.it / CQRobot DMX shield) and the
              "DmxSimple" library (Sketch > Include Library > Manage Libraries).
*/

#define MODE_PWM 1
#define MODE_DMX 2

#define OUTPUT_MODE MODE_PWM   // <-- change to MODE_DMX for DMX lights

const long BAUD = 115200;      // must match the Baud box in the web page

#if OUTPUT_MODE == MODE_DMX
  #include <DmxSimple.h>
  const int DMX_PIN = 3;        // pin wired to the shield's DI / TX input
  const int DMX_CHANNELS = 512;
#else
  // PWM-capable pins on an Uno / Nano. On a Mega you can list many more (2-13, 44-46).
  const byte PWM_PINS[] = {3, 5, 6, 9, 10, 11};
  const int PWM_COUNT = sizeof(PWM_PINS) / sizeof(PWM_PINS[0]);
#endif

char lineBuf[16];
byte lineLen = 0;

void setOutput(int channel, int value) {
  if (value < 0) value = 0;
  if (value > 255) value = 255;
#if OUTPUT_MODE == MODE_DMX
  if (channel >= 1 && channel <= DMX_CHANNELS) DmxSimple.write(channel, value);
#else
  if (channel >= 1 && channel <= PWM_COUNT) analogWrite(PWM_PINS[channel - 1], value);
#endif
}

void sendReady() {
#if OUTPUT_MODE == MODE_DMX
  Serial.print(F("LD READY DMX "));
  Serial.println(DMX_CHANNELS);
#else
  Serial.print(F("LD READY PWM "));
  Serial.println(PWM_COUNT);
#endif
}

void handleLine(char *s) {
  if (s[0] == '?') { sendReady(); return; }

  char *comma = strchr(s, ',');
  if (!comma) return;               // ignore anything we don't understand
  *comma = '\0';
  int channel = atoi(s);
  int value = atoi(comma + 1);
  setOutput(channel, value);
}

void setup() {
  Serial.begin(BAUD);

#if OUTPUT_MODE == MODE_DMX
  DmxSimple.usePin(DMX_PIN);
  DmxSimple.maxChannel(DMX_CHANNELS);
#else
  for (int i = 0; i < PWM_COUNT; i++) {
    pinMode(PWM_PINS[i], OUTPUT);
    analogWrite(PWM_PINS[i], 0);
  }
#endif

  sendReady();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0) {
        lineBuf[lineLen] = '\0';
        handleLine(lineBuf);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0;                   // line too long - drop it
    }
  }
}
