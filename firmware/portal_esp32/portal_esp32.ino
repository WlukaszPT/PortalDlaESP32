// CloudEA – program testowy dla ESP32 (płytka ESP32 DevKit, Arduino IDE).
//
// Co robi:
//  - co 20 s zwiększa "counter" (od 7:00 do 19:00 o 1, od 19:00 do 7:00 o 0,3), losuje "napiecie"
//    (11,8–13,2 V) i wysyła oba do bazy; counter idzie do bazy w całościach (23,3 -> 23),
//  - o północy (czas polski z internetu) counter wraca do zera,
//  - counter jest zapisywany w pamięci flash, więc po restarcie liczy dalej od tej samej wartości,
//  - co 5 s pyta bazę o polecenia; przycisk „Uruchom przejście” na stronie (zakładka Urządzenia)
//    ustawia tornOn = true, a wbudowana dioda świeci wtedy 10 s.
//
// Wymagane biblioteki: ArduinoJson (Menedżer bibliotek, wersja 7.x).
// Przed kompilacją skopiuj secrets.example.h jako secrets.h i uzupełnij dane.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Ticker.h>
#include <time.h>
#include <Preferences.h>

#include "secrets.h"
#include "root_ca.h"

const int LED_PIN = 2;  // ESP32 DevKit (DOIT V1): niebieska dioda na GPIO2

const unsigned long READING_INTERVAL_MS = 20000;  // wysyłanie odczytu
const unsigned long COMMAND_INTERVAL_MS = 5000;   // sprawdzanie poleceń
const float LED_ON_S = 10.0;  // świecenie diody po poleceniu ze strony

// Czas polski (zimą CET, latem CEST) z serwerów NTP.
const char* TIMEZONE = "CET-1CEST,M3.5.0,M10.5.0/3";
const int DAY_START_HOUR = 7;   // od 7:00 counter rośnie o 1
const int DAY_END_HOUR   = 19;  // od 19:00 counter rośnie o 0,3

// Nazwy danych w bazie dla typu AllinOne (zakładka Urządzenia → wybór danych).
const char* METRIC_COUNTER = "activations";      // Ilość uruchomień
const char* METRIC_VOLTAGE = "battery_voltage";  // Napięcie akumulatora
const char* CMD_TURN_ON    = "turn on";          // polecenie z przycisku na stronie

// Counter liczony w dziesiątych częściach (10 = 1,0; 3 = 0,3), żeby uniknąć błędów zaokrągleń.
long  counterTenths = 0;
int   counterDay = -1;  // dzień (rok * 1000 + dzień roku), w którym liczymy; -1 = jeszcze nieznany

Preferences store;  // pamięć flash (NVS), przetrwa restart i odłączenie zasilania
float napiecie = 0;
bool  tornOn = false;

unsigned long lastReading = 0;
unsigned long lastCommandCheck = 0;
WiFiClientSecure tls;
// Timer gasi diodę po 10 s, także wtedy, gdy ESP32 czeka na odpowiedź bazy.
Ticker ledOffTicker;

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
  http.setConnectTimeout(10000);
  http.setTimeout(10000);
  http.setReuse(false);  // każde zapytanie na nowym połączeniu, serwer je zamyka
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");

  String payload;
  serializeJson(body, payload);
  int code = http.POST(payload);
  if (code == 204) {
    // Pusta odpowiedź (np. potwierdzenie polecenia). Nie czytamy treści,
    // bo HTTPClient czekałby wtedy w nieskończoność na dane, które nie przyjdą.
    response = "";
  } else if (code > 0) {
    response = http.getString();
  } else {
    response = http.errorToString(code);
  }
  http.end();
  tls.stop();
  return code;
}

// ───────────── Czas ─────────────

bool localTimeNow(struct tm& now) {
  return getLocalTime(&now, 100);  // false, dopóki zegar nie pobrał czasu z internetu
}

// ───────────── Odczyty ─────────────

void loadCounter() {
  store.begin("cloudea", false);
  counterTenths = store.getLong("counter", 0);
  counterDay = store.getInt("day", -1);
  Serial.printf("Counter z pamięci: %.1f\n", counterTenths / 10.0);
}

// Zapis po każdej zmianie: pamięć NVS rozkłada zapisy po flashu, co 20 s to bezpieczne na lata.
void saveCounter() {
  store.putLong("counter", counterTenths);
  store.putInt("day", counterDay);
}

void updateCounter() {
  struct tm now;
  if (!localTimeNow(now)) {
    Serial.println("Brak aktualnego czasu, licznik +1");
    counterTenths += 10;
    saveCounter();
    return;
  }

  int today = (now.tm_year + 1900) * 1000 + now.tm_yday;
  if (counterDay != today) {
    // Nowy dzień (północ albo płytka była wyłączona przez noc): zerujemy.
    if (counterDay != -1) {
      Serial.println("Nowy dzień: zeruję counter");
      counterTenths = 0;
    }
    counterDay = today;
  }

  bool day = now.tm_hour >= DAY_START_HOUR && now.tm_hour < DAY_END_HOUR;
  counterTenths += day ? 10 : 3;
  saveCounter();
}

void sendReading() {
  updateCounter();
  long counter = counterTenths / 10;  // do bazy tylko całości: 23,3 -> 23
  napiecie = random(1180, 1321) / 100.0;  // 11,80–13,20 V

  JsonDocument body;
  body["p_key"] = DEVICE_KEY;
  body["p_data"][METRIC_COUNTER] = counter;
  body["p_data"][METRIC_VOLTAGE] = napiecie;

  String response;
  int code = callRpc("device_push_reading", body, response);
  Serial.printf("Odczyt: counter=%.1f (wysłano %ld), napiecie=%.2f V -> HTTP %d %s\n",
                counterTenths / 10.0, counter, napiecie, code, response.c_str());
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

void turnOffLed() {
  digitalWrite(LED_PIN, LOW);
  tornOn = false;
}

// Wywoływane po poleceniu ze strony: dioda świeci 10 s, potem gaśnie.
void turnOnLed() {
  tornOn = true;
  digitalWrite(LED_PIN, HIGH);
  ledOffTicker.once(LED_ON_S, turnOffLed);
}

// ───────────── Program ─────────────

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  randomSeed(esp_random());
  loadCounter();

  tls.setCACert(ROOT_CA);
  connectWiFi();
  configTzTime(TIMEZONE, "pool.ntp.org", "time.google.com");
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
