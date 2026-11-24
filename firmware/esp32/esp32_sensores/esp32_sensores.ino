#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <DHT.h>

// --- Pines ---
#define TCA_ADDR 0x70
#define ONE_WIRE_BUS 4
#define DHT_PIN 18
#define DHT_TYPE DHT22
#define RELE_PIN 23

// --- Objetos ---
Adafruit_ADS1115 ads;
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature ds18b20(&oneWire);
DHT dht(DHT_PIN, DHT_TYPE);

// --- Tiempos (millis) para lectura escalonada ---
unsigned long t_ads = 0;
unsigned long t_ds_req = 0;
unsigned long t_ds_read = 0;
unsigned long t_dht = 0;

bool ds_solicitud_pendiente = false;

void tcaSelect(uint8_t channel) {
  if (channel > 7) return;
  Wire.beginTransmission(TCA_ADDR);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

void enviarJson(const char* codigo, float valor, int crudo) {
  Serial.print("{\"s\":\"");
  Serial.print(codigo);
  Serial.print("\",\"v\":");
  Serial.print(valor, 4);
  Serial.print(",\"raw\":");
  Serial.print(crudo);
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);

  pinMode(RELE_PIN, OUTPUT);
  digitalWrite(RELE_PIN, LOW); // Apagado inicial (revisa si tu relé es activo en HIGH o LOW)

  tcaSelect(0);
  if (!ads.begin(0x48)) {
    Serial.println("{\"error\":\"ADS1115_no_detectado_en_CH0\"}");
  }
  ads.setGain(GAIN_TWOTHIRDS); // ±6.144V (seguro hasta 3.3V)

  ds18b20.begin();
  ds18b20.setWaitForConversion(false); // Asíncrono: no bloquea el loop
  dht.begin();
}

void loop() {
  unsigned long ahora = millis();

  // 1. Lecturas analógicas vía TCA9548A CH0 -> ADS1115 (cada 1000 ms, escalonadas)
  if (ahora - t_ads >= 1000) {
    t_ads = ahora;
    tcaSelect(0);

    int16_t raw_suelo = ads.readADC_SingleEnded(0);
    // Ajusta estos valores raw según tu calibración (aire seco vs agua)
    float pct_suelo = map(raw_suelo, 24000, 10000, 0, 100);
    pct_suelo = constrain(pct_suelo, 0.0, 100.0);
    enviarJson("SUELO_01", pct_suelo, raw_suelo);

    int16_t raw_co2 = ads.readADC_SingleEnded(1);
    float volt_co2 = ads.computeVolts(raw_co2);
    enviarJson("CO2_01", volt_co2, raw_co2);

    int16_t raw_bio = ads.readADC_SingleEnded(2);
    float mv_bio = ads.computeVolts(raw_bio) * 1000.0;
    enviarJson("BIO_ECG_01", mv_bio, raw_bio);
  }

  // 2. DS18B20 asíncrono: pedir conversión cada 1000 ms, leer 800 ms después
  if (!ds_solicitud_pendiente && (ahora - t_ds_req >= 1000)) {
    t_ds_req = ahora;
    ds18b20.requestTemperatures();
    t_ds_read = ahora;
    ds_solicitud_pendiente = true;
  }

  if (ds_solicitud_pendiente && (ahora - t_ds_read >= 800)) {
    ds_solicitud_pendiente = false;
    float temp_sust = ds18b20.getTempCByIndex(0);
    if (temp_sust > -100.0) {
      enviarJson("TEMP_SUST_01", temp_sust, 0);
    }
  }

  // 3. DHT22 cada 2200 ms (respetando su tiempo mínimo de muestreo)
  if (ahora - t_dht >= 2200) {
    t_dht = ahora;
    float hum_amb = dht.readHumidity();
    float temp_amb = dht.readTemperature();
    if (!isnan(hum_amb)) {
      enviarJson("DHT22_01_HUM", hum_amb, 0);
    }
    if (!isnan(temp_amb)) {
      enviarJson("DHT22_01_TEMP", temp_amb, 0);
    }
  }
}
