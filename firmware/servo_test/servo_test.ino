// Bench firmware: PCA9685 servo control over serial, with a frame queue played at 50 Hz.
//
// Protocol (115200 baud, one command per line). Replies "OK ..." or "ERR ...".
// Prints "READY servo_test v3" after boot.
//
// Immediate commands (refused while queued frames are playing; send F first):
//   S <channel> <us>         set channel 0-5 to a pulse width in microseconds
//   A <us0> <us1> ... <us5>  set channels 0-5 together (all pulses checked first)
//   O <channel>              turn channel off (servo goes limp)
//
// Streaming commands (motion scripts). The laptop keeps the queue topped up; the Uno
// plays one frame every 20 ms on its own clock, so laptop or USB hiccups shorter than
// the queued time don't reach the servos.
//   Q <us0> ... <us5>  append a frame (all pulses checked first)   -> OK Q <queued> <underruns>
//   ?                  status                                       -> OK ? <queued> <underruns> <played>
//   E                  end of stream: play out what's queued, then hold; no more underrun counting
//   F                  flush: drop queued frames, hold the frame playing now -> OK F <dropped>
// Underrun: a frame was due while streaming but the queue was empty. The servos hold the
// last frame (a pose the host already validated) and the counter goes up.
//
// Degrees -> microseconds (centre, trim, direction, us/deg, horn limits) is done by the
// host scripts from rig.json, so no rig numbers live here. This sketch only enforces an
// absolute pulse window that no servo should leave.

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

const uint8_t PCA9685_ADDR = 0x40;
const uint8_t NUM_CHANNELS = 6;
const uint16_t ABS_MIN_US = 500;
const uint16_t ABS_MAX_US = 2500;
const float SERVO_FREQ_HZ = 50;
const uint32_t PCA9685_OSC_HZ = 25000000;  // nominal internal oscillator
const uint32_t I2C_TIMEOUT_US = 25000;     // a stuck bus reports an error instead of hanging
const uint32_t FRAME_US = 20000;           // queue playback period (50 Hz, one servo PWM period)
const uint8_t QUEUE_LEN = 48;              // 0.96 s of frames; 12 bytes each

Adafruit_PWMServoDriver pwm(PCA9685_ADDR);
char line[48];  // fits "Q 2500 2500 2500 2500 2500 2500"
uint8_t lineLen = 0;
bool lineOverflow = false;
bool driverOk = false;
float usPerTick = 0;  // from the PCA9685's actual prescale

uint16_t queue[QUEUE_LEN][NUM_CHANNELS];
uint8_t qHead = 0, qCount = 0;
bool streaming = false;
bool playing = false;  // a playback clock is running
uint32_t nextDue = 0;
uint32_t underruns = 0, played = 0;

bool pca9685Present() {
  Wire.clearWireTimeoutFlag();
  Wire.beginTransmission(PCA9685_ADDR);
  return Wire.endTransmission() == 0 && !Wire.getWireTimeoutFlag();
}

// True (and clears the flag) if an I2C transfer timed out since the last check.
bool i2cTimedOut() {
  bool t = Wire.getWireTimeoutFlag();
  Wire.clearWireTimeoutFlag();
  return t;
}

// True if us is inside the absolute window; otherwise prints an ERR line.
bool pulseOk(unsigned int us) {
  if (us >= ABS_MIN_US && us <= ABS_MAX_US) return true;
  Serial.print(F("ERR pulse outside "));
  Serial.print(ABS_MIN_US);
  Serial.print('-');
  Serial.print(ABS_MAX_US);
  Serial.print(F(" us: "));
  Serial.println(us);
  return false;
}

// Same result as Adafruit's writeMicroseconds, without re-reading the prescale over I2C each call.
void writeUs(uint8_t ch, uint16_t us) {
  pwm.setPWM(ch, 0, (uint16_t)(us / usPerTick));
}

// Write all six channels; false (and an ERR line if report) on an I2C timeout.
bool writeFrame(const uint16_t *us, bool report) {
  for (uint8_t i = 0; i < NUM_CHANNELS; i++) writeUs(i, us[i]);
  if (!i2cTimedOut()) return true;
  if (report) Serial.println(F("ERR I2C timeout talking to PCA9685"));
  return false;
}

void playQueue() {
  if (!playing) return;
  uint32_t now = micros();
  if ((int32_t)(now - nextDue) < 0) return;
  if (qCount == 0) {
    if (streaming) underruns++;
    else playing = false;  // stream ended and fully played: hold the last frame
    nextDue = now + FRAME_US;
    return;
  }
  writeFrame(queue[qHead], false);
  qHead = (qHead + 1) % QUEUE_LEN;
  qCount--;
  played++;
  // Stay on the 20 ms grid; if the Uno itself fell more than a frame behind, restart the grid.
  nextDue += FRAME_US;
  if ((int32_t)(now - nextDue) > (int32_t)FRAME_US) nextDue = now + FRAME_US;
}

void replyCounts(char op) {
  Serial.print(F("OK "));
  Serial.print(op);
  Serial.print(' ');
  Serial.print(qCount);
  Serial.print(' ');
  Serial.print(underruns);
  if (op == '?') {
    Serial.print(' ');
    Serial.print(played);
  }
  Serial.println();
}

void handleLine(char *cmd) {
  if (!driverOk) {
    Serial.println(F("ERR no PCA9685 at 0x40 or I2C bus stuck"));
    return;
  }
  char op = 0;
  unsigned int v[NUM_CHANNELS] = {0};
  int n = sscanf(cmd, "%c %u %u %u %u %u %u", &op, &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]);
  unsigned int ch = v[0], us = v[1];
  bool busy = qCount > 0;

  if (op == 'Q' && n == 1 + NUM_CHANNELS) {
    if (qCount >= QUEUE_LEN) {
      Serial.println(F("ERR queue full"));
      return;
    }
    for (uint8_t i = 0; i < NUM_CHANNELS; i++) {
      if (!pulseOk(v[i])) return;
    }
    uint8_t tail = (qHead + qCount) % QUEUE_LEN;
    for (uint8_t i = 0; i < NUM_CHANNELS; i++) queue[tail][i] = v[i];
    qCount++;
    if (!streaming) underruns = played = 0;  // a new stream starts its counters fresh
    streaming = true;
    if (!playing) {
      playing = true;
      nextDue = micros();
    }
    replyCounts('Q');
  } else if (op == '?' && n == 1) {
    replyCounts('?');
  } else if (op == 'E' && n == 1) {
    streaming = false;
    Serial.println(F("OK E"));
  } else if (op == 'F' && n == 1) {
    uint8_t dropped = qCount;
    qCount = 0;
    streaming = false;
    Serial.print(F("OK F "));
    Serial.println(dropped);
  } else if ((op == 'A' || op == 'S' || op == 'O') && busy) {
    Serial.println(F("ERR queue playing; send F first"));
  } else if (op == 'A' && n == 1 + NUM_CHANNELS) {
    // All channels in one frame: check every pulse first so a bad frame moves nothing.
    uint16_t frame[NUM_CHANNELS];
    for (uint8_t i = 0; i < NUM_CHANNELS; i++) {
      if (!pulseOk(v[i])) return;
      frame[i] = v[i];
    }
    if (writeFrame(frame, true)) Serial.println(F("OK A"));
  } else if ((op == 'S' || op == 'O') && n >= 2 && ch >= NUM_CHANNELS) {
    Serial.print(F("ERR channel out of range: "));
    Serial.println(ch);
  } else if (op == 'S' && n == 3) {
    if (!pulseOk(us)) return;
    writeUs(ch, us);
    if (i2cTimedOut()) {
      Serial.println(F("ERR I2C timeout talking to PCA9685"));
      return;
    }
    Serial.print(F("OK S "));
    Serial.print(ch);
    Serial.print(' ');
    Serial.println(us);
  } else if (op == 'O' && n == 2) {
    pwm.setPWM(ch, 0, 4096);  // full off
    if (i2cTimedOut()) {
      Serial.println(F("ERR I2C timeout talking to PCA9685"));
      return;
    }
    Serial.print(F("OK O "));
    Serial.println(ch);
  } else {
    Serial.print(F("ERR bad command: "));
    Serial.println(cmd);
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setWireTimeout(I2C_TIMEOUT_US, true);
  driverOk = pca9685Present();
  if (driverOk) {
    pwm.begin();
    pwm.setOscillatorFrequency(PCA9685_OSC_HZ);
    pwm.setPWMFreq(SERVO_FREQ_HZ);
    Wire.setClock(400000);  // a full frame is six I2C writes; 400 kHz keeps that well under 1 ms
    usPerTick = 1e6f * (pwm.readPrescale() + 1) / PCA9685_OSC_HZ;
    driverOk = !i2cTimedOut();
  }
  Serial.println(driverOk ? F("READY servo_test v3")
                          : F("READY servo_test v3 (ERR no PCA9685 at 0x40 or I2C bus stuck)"));
}

void loop() {
  playQueue();
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[lineLen] = '\0';
      if (lineOverflow) Serial.println(F("ERR line too long"));
      else if (lineLen > 0) handleLine(line);
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    } else {
      lineOverflow = true;
    }
    playQueue();  // keep the 20 ms grid even while a command is arriving
  }
}
