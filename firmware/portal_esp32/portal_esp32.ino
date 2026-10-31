// CloudEA – program testowy dla ESP32 (płytka ESP32 DevKit, Arduino IDE).
//
// Co robi:
//  - co 60 s zwiększa "counter" (od 7:00 do 19:00 o 1, od 19:00 do 7:00 o 0,3), losuje "napiecie"
//    (11,8–13,2 V) i wysyła oba do bazy; counter idzie do bazy w całościach (23,3 -> 23),
//  - o północy (czas polski z internetu) counter wraca do zera,
//  - counter jest zapisywany w pamięci flash, więc po restarcie liczy dalej od tej samej wartości,
//  - co 5 s pyta bazę o polecenia; przycisk „Uruchom przejście” na stronie (zakładka Urządzenia)
//    ustawia tornOn = true, a wbudowana dioda świeci wtedy 10 s,
//  - po dotknięciu palcem pinu dotykowego T0 (GPIO4, opisany na płytce D4) pobiera z bazy
//    „Wiadomość serwera” (zakładka na stronie) i wypisuje ją w monitorze portu szeregowego;
//    wiadomość nie jest przechowywana w pamięci ESP32, przy każdym dotyku pobierana jest od nowa,
//  - wbudowana dioda miga co 1 s (podczas „Uruchom przejście” świeci ciągle 10 s,
//    podczas pobierania nowego programu miga szybko),
//  - co minutę pyta stronę, czy w zakładce Firmware jest nowsza wersja programu; jeśli tak,
//    pobiera plik .bin przez HTTPS, zapisuje go we flashu i uruchamia się ponownie (OTA).
//
// ZDALNA AKTUALIZACJA – jak wydać nową wersję:
//  1. Podnieś FW_VERSION poniżej (np. z 1 na 2).
//  2. Arduino IDE: Szkic → Eksportuj skompilowany plik binarny. Plik .bin pojawi się w folderze
//     szkicu (lub w podfolderze build/...). Wybierz ten bez „bootloader”/„partitions”/„merged” w nazwie.
//  3. Strona → inwestycja → Firmware → wybierz urządzenie, dodaj plik .bin (i ewentualnie .ino).
//  Schemat partycji (Narzędzia → Partition Scheme) musi mieć miejsce na OTA, np. „Default 4MB
//  with spiffs” (program do 1,25 MB) albo „Minimal SPIFFS (1.9MB APP with OTA)”.
//  Pierwszy program z tą funkcją trzeba wgrać przez kabel USB.
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
#include <Update.h>

#include "secrets.h"
#include "root_ca.h"

// Numer wersji tego programu. Podnieś go przed każdym wgraniem na stronę (zakładka Firmware).
#define FW_VERSION 1

#define STR_(x) #x
#define STR(x) STR_(x)
// Po tym napisie strona odczytuje numer wersji z pliku .bin. Nie zmieniaj jego treści.
const char FW_TAG[] = "CLOUDEA_FW_VERSION=" STR(FW_VERSION);

const int LED_PIN = 2;  // ESP32 DevKit (DOIT V1): niebieska dioda na GPIO2
const int TOUCH_PIN = T0;  // pin dotykowy T0 = GPIO4 (na płytce D4); wystarczy dotknąć go palcem lub kablem

const unsigned long READING_INTERVAL_MS = 60000;  // wysyłanie odczytu
const unsigned long COMMAND_INTERVAL_MS = 5000;   // sprawdzanie poleceń
const unsigned long FIRMWARE_INTERVAL_MS = 60000; // sprawdzanie nowej wersji programu
const int FIRMWARE_MAX_TRIES = 3;                 // tyle prób pobrania jednej wersji, potem odpuszczamy
const unsigned long TOUCH_DEBOUNCE_MS = 50;       // tyle musi trwać dotyk/puszczenie, żeby się liczyło
const float LED_ON_S = 10.0;  // świecenie diody po poleceniu ze strony
const float BLINK_S = 1.0;   // miganie diody: zmiana co 1 s
const float BLINK_OTA_S = 0.1;  // szybkie miganie podczas aktualizacji

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
unsigned long lastFirmwareCheck = 0;
bool firmwareChecked = false;  // pierwsze sprawdzenie zaraz po połączeniu z Wi-Fi

uint16_t touchThreshold = 0;      // poniżej tej wartości touchRead() uznajemy pin za dotknięty
// Przerwanie od pinu dotykowego zaznacza dotyk także wtedy, gdy loop() czeka na bazę.
volatile bool touchFlag = false;
bool touchHeld = false;           // palec wciąż na pinie: nie wypisujemy drugi raz
unsigned long touchChangedAt = 0;
WiFiClientSecure tls;
// Timery działają niezależnie od loop(), więc dioda miga i gaśnie po 10 s także wtedy,
// gdy ESP32 czeka na odpowiedź bazy albo pobiera nowy program.
Ticker ledOffTicker;
Ticker blinkTicker;

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

// Zapis po każdej zmianie: pamięć NVS rozkłada zapisy po flashu, co minutę to bezpieczne na lata.
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

// ───────────── Wiadomość serwera ─────────────

// Wywoływane po dotknięciu pinu: pobiera aktualną wiadomość z bazy i od razu ją wypisuje.
void showServerMessage() {
  Serial.println(">>> Dotyk: pobieram wiadomość serwera...");
  JsonDocument body;
  body["p_key"] = DEVICE_KEY;

  String response;
  int code = callRpc("device_get_message", body, response);
  if (code != 200) {
    Serial.printf(">>> Nie udało się pobrać wiadomości: HTTP %d %s\n", code, response.c_str());
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    Serial.println(">>> Nie udało się pobrać wiadomości: niepoprawny JSON");
    return;
  }
  const char* message = doc["message"] | "";
  if (message[0] == '\0') {
    Serial.println(">>> Brak wiadomości serwera");
  } else {
    Serial.printf(">>> Wiadomość serwera: %s\n", message);
  }
}

void IRAM_ATTR onTouch() {
  touchFlag = true;
}

// Mierzy pin, gdy nikt go nie dotyka (przy starcie), i ustawia próg na 2/3 tej wartości.
void calibrateTouch() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += touchRead(TOUCH_PIN);
    delay(10);
  }
  uint16_t base = sum / 16;
  touchThreshold = base * 2 / 3;
  Serial.printf("Pin dotykowy GPIO4: spoczynek %u, próg %u\n", base, touchThreshold);
  touchAttachInterrupt(TOUCH_PIN, onTouch, touchThreshold);
}

// Jeden dotyk = jedna wiadomość. Kolejna dopiero po zabraniu palca (z odczekaniem debounce).
void checkTouch() {
  bool touched = touchRead(TOUCH_PIN) < touchThreshold;
  unsigned long now = millis();

  if (!touchHeld && (touchFlag || touched)) {
    if (touchChangedAt == 0) touchChangedAt = now;
    // Krótki dotyk w trakcie zapytania do bazy złapało przerwanie, więc liczy się od razu.
    if (touchFlag && !touched) touchChangedAt = now - TOUCH_DEBOUNCE_MS;
    if (now - touchChangedAt >= TOUCH_DEBOUNCE_MS) {
      touchHeld = true;
      touchChangedAt = 0;
      showServerMessage();
    }
  } else if (touchHeld && !touched) {
    if (touchChangedAt == 0) touchChangedAt = now;
    if (now - touchChangedAt >= TOUCH_DEBOUNCE_MS) {
      touchHeld = false;
      touchChangedAt = 0;
    }
  } else {
    touchChangedAt = 0;
  }
  touchFlag = false;
}

// ───────────── Zdalna aktualizacja (OTA) ─────────────

// Przekazuje pobierane bajty prosto do zapisu we flashu (HTTPClient::writeToStream
// sam rozpakowuje odpowiedź, także przesyłaną w kawałkach).
class UpdateSink : public Stream {
 public:
  size_t write(uint8_t b) override { return Update.write(&b, 1); }
  size_t write(const uint8_t* buf, size_t len) override { return Update.write(const_cast<uint8_t*>(buf), len); }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};

// Pobiera wersję `version` (rozmiar `size` bajtów) i zapisuje ją jako nowy program.
// Przy sukcesie ESP32 uruchamia się ponownie i nie wraca z tej funkcji.
bool downloadFirmware(long version, long size) {
  Serial.printf("OTA: pobieram wersję %ld (%ld B)...\n", version, size);
  if (!Update.begin(size)) {
    Serial.printf("OTA: brak miejsca na program (%s). Wybierz schemat partycji z OTA.\n", Update.errorString());
    return false;
  }

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/functions/v1/device-firmware";
  if (!http.begin(tls, url)) { Update.abort(); return false; }
  http.setConnectTimeout(10000);
  http.setTimeout(20000);
  http.setReuse(false);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");

  JsonDocument body;
  body["key"] = DEVICE_KEY;
  body["version"] = version;
  String payload;
  serializeJson(body, payload);

  startBlink(BLINK_OTA_S);
  int code = http.POST(payload);
  bool ok = false;
  if (code == 200) {
    UpdateSink sink;
    int written = http.writeToStream(&sink);
    ok = written == size && Update.end() && Update.isFinished();
    if (!ok) Serial.printf("OTA: zapis nieudany (pobrano %d B, %s)\n", written, Update.errorString());
  } else {
    Serial.printf("OTA: HTTP %d %s\n", code, code > 0 ? http.getString().c_str() : "");
  }
  if (!ok) Update.abort();
  http.end();
  tls.stop();
  startBlink(BLINK_S);

  if (ok) {
    Serial.printf("OTA: wersja %ld zapisana, uruchamiam ponownie\n", version);
    delay(500);
    ESP.restart();
  }
  return ok;
}

// Pyta stronę, czy jest nowsza wersja programu niż FW_VERSION; jeśli tak, pobiera ją.
void checkFirmware() {
  JsonDocument body;
  body["p_key"] = DEVICE_KEY;
  body["p_version"] = FW_VERSION;

  String response;
  int code = callRpc("device_check_firmware", body, response);
  if (code != 200) {
    Serial.printf("Firmware: HTTP %d %s\n", code, response.c_str());
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    Serial.println("Firmware: niepoprawny JSON");
    return;
  }
  if (!(doc["update"] | false)) return;

  long version = doc["version"] | 0L;
  long size = doc["size"] | 0L;
  if (version <= FW_VERSION || size <= 0) return;

  // Ta sama wersja nie udała się już kilka razy (np. za duży plik): nie próbujemy w kółko.
  int tries = store.getLong("fw_ver", 0) == version ? store.getInt("fw_tries", 0) : 0;
  if (tries >= FIRMWARE_MAX_TRIES) return;
  store.putLong("fw_ver", version);
  store.putInt("fw_tries", tries + 1);

  if (!downloadFirmware(version, size) && tries + 1 >= FIRMWARE_MAX_TRIES) {
    Serial.printf("OTA: wersja %ld nie udała się %d razy, nie próbuję więcej. Wgraj nowszą.\n", version, FIRMWARE_MAX_TRIES);
  }
}

// ───────────── Dioda ─────────────

// Co BLINK_S zmienia stan diody. Gdy trwa „przejście” (tornOn), dioda świeci ciągle.
void blinkTick() {
  if (tornOn) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }
}

void startBlink(float seconds) {
  blinkTicker.detach();
  blinkTicker.attach(seconds, blinkTick);
}

// Po 10 s „przejścia” dioda wraca do zwykłego migania.
void turnOffLed() {
  tornOn = false;
  digitalWrite(LED_PIN, LOW);
}

// Wywoływane po poleceniu ze strony: dioda świeci ciągle 10 s, potem znowu miga.
void turnOnLed() {
  tornOn = true;
  digitalWrite(LED_PIN, HIGH);
  ledOffTicker.once(LED_ON_S, turnOffLed);
}

// ───────────── Program ─────────────

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("CloudEA, wersja programu %d (%s)\n", FW_VERSION, FW_TAG);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  startBlink(BLINK_S);
  randomSeed(esp_random());
  loadCounter();

  calibrateTouch();  // nie dotykaj pinu GPIO4 podczas startu

  tls.setCACert(ROOT_CA);
  connectWiFi();
  configTzTime(TIMEZONE, "pool.ntp.org", "time.google.com");
}

void loop() {
  checkTouch();
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
  if (WiFi.status() == WL_CONNECTED &&
      (!firmwareChecked || now - lastFirmwareCheck >= FIRMWARE_INTERVAL_MS)) {
    firmwareChecked = true;
    lastFirmwareCheck = now;
    checkFirmware();
  }
  checkTouch();

  delay(50);
}
