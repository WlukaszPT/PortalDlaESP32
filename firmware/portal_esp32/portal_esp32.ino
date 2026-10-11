// CloudEA – program testowy dla ESP32 (płytka ESP32 DevKit, Arduino IDE).
//
// Co robi:
//  - co 20 s zwiększa "counter" o 1, losuje "napiecie" (11,8–13,2 V) i wysyła oba do bazy,
//  - wbudowana dioda zmienia stan co 1 s (znak, że program działa),
//  - co 5 s pyta bazę o polecenia; przycisk „Uruchom przejście” na stronie (zakładka Urządzenia)
//    ustawia tornOn = true, a dioda świeci wtedy bez przerwy 10 s i wraca do migania.
//
// Wymagane biblioteki: ArduinoJson (Menedżer bibliotek, wersja 7.x).
// Przed kompilacją skopiuj secrets.example.h jako secrets.h i uzupełnij dane.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Ticker.h>

#include "secrets.h"
#include "root_ca.h"

const int LED_PIN = 2;  // ESP32 DevKit (DOIT V1): niebieska dioda na GPIO2

const unsigned long READING_INTERVAL_MS = 20000;  // wysyłanie odczytu
const unsigned long COMMAND_INTERVAL_MS = 5000;   // sprawdzanie poleceń
const float BLINK_INTERVAL_S = 1.0;   // miganie diody
const float LED_ON_S         = 10.0;  // ciągłe świecenie po poleceniu ze strony

// Nazwy danych w bazie dla typu AllinOne (zakładka Urządzenia → wybór danych).
const char* METRIC_COUNTER = "activations";      // Ilość uruchomień
const char* METRIC_VOLTAGE = "battery_voltage";  // Napięcie akumulatora
const char* CMD_TURN_ON    = "turn on";          // polecenie z przycisku na stronie

long  counter = 0;
float napiecie = 0;
bool  tornOn = false;

unsigned long lastReading = 0;
unsigned long lastCommandCheck = 0;
volatile bool ledState = false;

WiFiClientSecure tls;
// Dioda jest sterowana timerami, więc miga równo także wtedy, gdy ESP32 czeka na odpowiedź bazy.
Ticker blinkTicker;
Ticker ledOnTicker;

// ───────────── Wi‑Fi ─────────────

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Łączę z Wi-Fi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nPołączono, IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nBrak Wi-Fi, spróbuję ponownie później.");
  }
}

// ───────────── Supabase RPC ─────────────

// Wywołuje funkcję device_* w bazie. Zwraca kod HTTP (lub ujemny przy błędzie połączenia).
int callRpc(const char* function, const JsonDocument& body, String& response) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/rpc/" + function;
  if (!http.begin(tls, url)) return -2;
  http.setTimeout(10000);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");

  String payload;
  serializeJson(body, payload);
  int code = http.POST(payload);
  response = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  return code;
}

void sendReading() {
  counter++;
  napiecie = random(1180, 1321) / 100.0;  // 11,80–13,20 V

  JsonDocument body;
  body["p_key"] = DEVICE_KEY;
  body["p_data"][METRIC_COUNTER] = counter;
  body["p_data"][METRIC_VOLTAGE] = napiecie;

  String response;
  int code = callRpc("device_push_reading", body, response);
  Serial.printf("Odczyt: counter=%ld, napiecie=%.2f V -> HTTP %d %s\n",
                counter, napiecie, code, response.c_str());
}

void ackCommand(long id, bool ok, const char* result) {
  JsonDocument body;
  body["p_key"] = DEVICE_KEY;
  body["p_command_id"] = id;
  body["p_ok"] = ok;
  body["p_result"] = result;

  String response;
  int code = callRpc("device_ack_command", body, response);
  Serial.printf("Potwierdzenie polecenia %ld -> HTTP %d\n", id, code);
}

void checkCommands() {
  JsonDocument body;
  body["p_key"] = DEVICE_KEY;

  String response;
  int code = callRpc("device_fetch_commands", body, response);
  if (code != 200) {
    Serial.printf("Polecenia: HTTP %d %s\n", code, response.c_str());
    return;
  }

  JsonDocument commands;
  if (deserializeJson(commands, response)) {
    Serial.println("Polecenia: niepoprawny JSON");
    return;
  }

  for (JsonObject cmd : commands.as<JsonArray>()) {
    long id = cmd["id"];
    if (cmd["payload"][CMD_TURN_ON] == true) {
      Serial.printf("Polecenie %ld: włącz przejście\n", id);
      turnOnLed();
      ackCommand(id, true, "dioda włączona na 10 s");
    } else {
      ackCommand(id, false, "nieznane polecenie");
    }
  }
}

// ───────────── Dioda ─────────────

void toggleLed() {
  ledState = !ledState;
  digitalWrite(LED_PIN, ledState);
}

void startBlinking() {
  tornOn = false;
  blinkTicker.attach(BLINK_INTERVAL_S, toggleLed);
}

// Wywoływane po poleceniu ze strony: dioda świeci 10 s bez przerwy, potem znowu miga.
void turnOnLed() {
  tornOn = true;
  blinkTicker.detach();
  ledState = true;
  digitalWrite(LED_PIN, HIGH);
  ledOnTicker.once(LED_ON_S, startBlinking);
}

// ───────────── Program ─────────────

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  startBlinking();
  randomSeed(esp_random());

  tls.setCACert(ROOT_CA);
  connectWiFi();
}

void loop() {
  connectWiFi();
  unsigned long now = millis();

  if (now - lastReading >= READING_INTERVAL_MS || lastReading == 0) {
    lastReading = now;
    sendReading();
  }
  if (now - lastCommandCheck >= COMMAND_INTERVAL_MS) {
    lastCommandCheck = now;
    checkCommands();
  }

  delay(50);
}
