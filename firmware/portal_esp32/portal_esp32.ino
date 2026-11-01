// CloudEA – program testowy dla ESP32 (płytka ESP32 DevKit, Arduino IDE).
//
// Co robi:
//  - co 60 s zwiększa "counter" (od 7:00 do 19:00 o 1, od 19:00 do 7:00 o 0,3), losuje "napiecie"
//    (11,8–13,2 V) i wysyła oba do bazy; counter idzie do bazy w całościach (23,3 -> 23),
//  - o północy (czas polski z internetu) counter wraca do zera,
//  - counter jest zapisywany w pamięci flash, więc po restarcie liczy dalej od tej samej wartości,
//  - trzyma stałe połączenie WebSocket z Supabase Realtime: przycisk „Uruchom przejście” na stronie
//    (zakładka Urządzenia) od razu ustawia tornOn = true i zapala diodę, a „Wyłącz przejście” ją gasi,
//  - zabezpieczenie czasowe: jeśli nikt nie kliknie „Wyłącz przejście”, dioda gaśnie sama po 1 minucie,
//  - dodatkowo co 30 s (bez połączenia Realtime co 5 s) pyta bazę o polecenia, na wypadek gdyby
//    któreś nie dotarło przez WebSocket,
//  - po dotknięciu palcem pinu dotykowego T0 (GPIO4, opisany na płytce D4) pobiera z bazy
//    „Wiadomość serwera” (zakładka na stronie) i wypisuje ją w monitorze portu szeregowego;
//    wiadomość nie jest przechowywana w pamięci ESP32, przy każdym dotyku pobierana jest od nowa,
//  - wbudowana dioda miga co 1 s (podczas przejścia świeci ciągle,
//    podczas pobierania nowego programu miga szybko),
//  - co minutę pyta stronę, czy w zakładce Firmware jest nowsza wersja programu; jeśli tak,
//    pobiera plik .bin przez HTTPS, zapisuje go we flashu i uruchamia się ponownie (OTA).
//
// ZDALNA AKTUALIZACJA – jak wydać nową wersję:
//  1. Numer wersji ustawia się sam z daty i godziny kompilacji (RRMMDDGGMM, np. 2610311838
//     = 31.10.2026, 18:38), więc nic nie trzeba zmieniać w kodzie.
//  2. Arduino IDE: Szkic → Eksportuj skompilowany plik binarny. Plik .bin pojawi się w folderze
//     szkicu (lub w podfolderze build/...). Wybierz ten bez „bootloader”/„partitions”/„merged” w nazwie.
//  3. Strona → inwestycja → Firmware → wybierz urządzenie, dodaj plik .bin (i ewentualnie .ino).
//  Schemat partycji (Narzędzia → Partition Scheme) musi mieć miejsce na OTA, np. „Default 4MB
//  with spiffs” (program do 1,25 MB) albo „Minimal SPIFFS (1.9MB APP with OTA)”.
//  Pierwszy program z tą funkcją trzeba wgrać przez kabel USB.
//
// Wymagane biblioteki (Menedżer bibliotek): ArduinoJson (wersja 7.x)
// oraz WebSockets (autor Markus Sattler, wersja 2.6 lub nowsza).
// Przed kompilacją skopiuj secrets.example.h jako secrets.h i uzupełnij dane.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Ticker.h>
#include <time.h>
#include <Preferences.h>
#include <Update.h>
#include <WebSocketsClient.h>

#include "secrets.h"
#include "root_ca.h"

// Numer wersji programu liczony automatycznie z daty i godziny kompilacji (__DATE__ = "Oct 31 2026",
// __TIME__ = "18:38:12") w postaci RRMMDDGGMM, np. 2610311838. Każdy nowy eksport ma wyższy numer.
constexpr int fwDigit(char c) { return c == ' ' ? 0 : c - '0'; }
constexpr int fwMonth(const char* d) {
  return d[0] == 'J' ? (d[1] == 'a' ? 1 : (d[2] == 'n' ? 6 : 7))
       : d[0] == 'F' ? 2
       : d[0] == 'M' ? (d[2] == 'r' ? 3 : 5)
       : d[0] == 'A' ? (d[1] == 'p' ? 4 : 8)
       : d[0] == 'S' ? 9
       : d[0] == 'O' ? 10
       : d[0] == 'N' ? 11 : 12;
}
constexpr long long fwBuild(const char* d, const char* t) {
  return ((((long long)(fwDigit(d[9]) * 10 + fwDigit(d[10])) * 100 + fwMonth(d)) * 100
           + fwDigit(d[4]) * 10 + fwDigit(d[5])) * 100 + fwDigit(t[0]) * 10 + fwDigit(t[1])) * 100
         + fwDigit(t[3]) * 10 + fwDigit(t[4]);
}
const long long FW_VERSION = fwBuild(__DATE__, __TIME__);

// Po tym napisie strona odczytuje datę kompilacji (czyli wersję) z pliku .bin. Nie zmieniaj go.
const char FW_TAG[] = "CLOUDEA_FW_BUILD=" __DATE__ " " __TIME__;

const int LED_PIN = 2;  // ESP32 DevKit (DOIT V1): niebieska dioda na GPIO2
const int TOUCH_PIN = T0;  // pin dotykowy T0 = GPIO4 (na płytce D4); wystarczy dotknąć go palcem lub kablem

const unsigned long READING_INTERVAL_MS = 60000;  // wysyłanie odczytu
const unsigned long COMMAND_INTERVAL_MS = 5000;   // sprawdzanie poleceń, gdy nie ma połączenia Realtime
const unsigned long COMMAND_INTERVAL_LIVE_MS = 30000; // sprawdzanie poleceń przy działającym Realtime (zapas)
const unsigned long TOPIC_RETRY_MS = 30000;       // ponowne pytanie o kanał Realtime po błędzie
const unsigned long HEARTBEAT_MS = 25000;         // „jestem” wysyłane do Realtime (serwer wymaga co < 60 s)
const unsigned long SILENCE_LIMIT_MS = 70000;     // tyle ciszy od serwera = zerwane połączenie, łączymy od nowa
const long COMMAND_MAX_AGE_S = 60;                // starsze polecenie „włącz” (np. po braku zasilania) jest pomijane
const unsigned long FIRMWARE_INTERVAL_MS = 60000; // sprawdzanie nowej wersji programu
const int FIRMWARE_MAX_TRIES = 3;                 // tyle prób pobrania jednej wersji, potem odpuszczamy
const unsigned long TOUCH_DEBOUNCE_MS = 50;       // tyle musi trwać dotyk/puszczenie, żeby się liczyło
const float SAFETY_OFF_S = 60.0;  // zabezpieczenie: przejście gaśnie samo po 1 minucie
const float BLINK_S = 1.0;   // miganie diody: zmiana co 1 s
const float BLINK_OTA_S = 0.1;  // szybkie miganie podczas aktualizacji

// Czas polski (zimą CET, latem CEST) z serwerów NTP.
const char* TIMEZONE = "CET-1CEST,M3.5.0,M10.5.0/3";
const int DAY_START_HOUR = 7;   // od 7:00 counter rośnie o 1
const int DAY_END_HOUR   = 19;  // od 19:00 counter rośnie o 0,3

// Nazwy danych w bazie dla typu AllinOne (zakładka Urządzenia → wybór danych).
const char* METRIC_COUNTER = "activations";      // Ilość uruchomień
const char* METRIC_VOLTAGE = "battery_voltage";  // Napięcie akumulatora
const char* CMD_TURN_ON    = "turn on";          // przycisk „Uruchom przejście”
const char* CMD_TURN_OFF   = "turn off";         // przycisk „Wyłącz przejście”

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
// Timery działają niezależnie od loop(), więc dioda miga i gaśnie po 1 minucie także wtedy,
// gdy ESP32 czeka na odpowiedź bazy albo pobiera nowy program.
Ticker ledOffTicker;
Ticker blinkTicker;

// Stałe połączenie z Supabase Realtime (WebSocket, kanał Broadcast tego urządzenia).
WebSocketsClient ws;
String rtTopic;               // nazwa kanału z bazy (device_realtime_topic), np. cloudea-1b9d…
bool rtStarted = false;       // ws.begin… już wywołane (biblioteka sama łączy ponownie)
bool rtJoined = false;        // kanał dołączony: polecenia przychodzą od razu
unsigned long rtTopicTry = 0;
unsigned long rtLastHeartbeat = 0;
unsigned long rtLastMessage = 0;
unsigned long rtRef = 0;
String rtJoinRef;
bool fetchSoon = false;       // pobierz polecenia z bazy przy najbliższym obiegu loop()

// Ostatnie polecenia wykonane od razu z Realtime: przy pobraniu z bazy tylko je potwierdzamy.
long handledIds[8] = {0};
int handledPos = 0;

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

bool wasHandled(long id) {
  for (long h : handledIds) if (h == id) return true;
  return false;
}

void markHandled(long id) {
  handledIds[handledPos] = id;
  handledPos = (handledPos + 1) % 8;
}

// Czas utworzenia polecenia ("2026-11-01T10:53:03.95+00:00", UTC) w sekundach od 1970.
long long parseUtc(const char* s) {
  int y, mo, d, h, mi, sec;
  if (!s || sscanf(s, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &sec) != 6) return 0;
  y -= mo <= 2;
  long long era = (y >= 0 ? y : y - 399) / 400;
  long long yoe = y - era * 400;
  long long doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  long long days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
  return days * 86400 + h * 3600 + mi * 60 + sec;
}

// Wykonuje polecenie. Zwraca opis do potwierdzenia; ok = false, gdy polecenie nieznane lub pominięte.
const char* runCommand(long id, JsonVariantConst payload, const char* createdAt, bool& ok) {
  ok = true;
  if (payload[CMD_TURN_OFF] == true) {
    Serial.printf("Polecenie %ld: wyłącz przejście\n", id);
    stopPassage();
    return "przejście wyłączone";
  }
  if (payload[CMD_TURN_ON] == true) {
    // Polecenie sprzed dłuższego czasu (np. ESP32 było wyłączone) nie zapala już diody.
    time_t now = time(nullptr);
    long long created = parseUtc(createdAt);
    if (now > 1700000000 && created > 0 && now - created > COMMAND_MAX_AGE_S) {
      Serial.printf("Polecenie %ld: włącz przejście – pominięte, wysłane %lld s temu\n", id, (long long)now - created);
      ok = false;
      return "pominięte: polecenie starsze niż 1 minuta";
    }
    Serial.printf("Polecenie %ld: włącz przejście\n", id);
    turnOnLed();
    return "przejście włączone (samo wyłączy się po 1 min)";
  }
  ok = false;
  return "nieznane polecenie";
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
    if (wasHandled(id)) {
      // Już wykonane od razu po wiadomości z Realtime: tylko potwierdzamy w bazie.
      ackCommand(id, true, "wykonane natychmiast (Realtime)");
      continue;
    }
    bool ok;
    const char* result = runCommand(id, cmd["payload"].as<JsonVariantConst>(), cmd["created_at"].as<const char*>(), ok);
    if (ok) markHandled(id);
    ackCommand(id, ok, result);
  }
}

// ───────────── Stałe połączenie (Supabase Realtime) ─────────────

void rtSend(const char* topic, const char* event, JsonDocument& payload, const String& joinRef) {
  JsonDocument msg;
  msg["topic"] = topic;
  msg["event"] = event;
  msg["payload"] = payload;
  msg["ref"] = String(++rtRef);
  if (joinRef.length()) msg["join_ref"] = joinRef;
  String text;
  serializeJson(msg, text);
  ws.sendTXT(text);
}

void rtJoin() {
  JsonDocument payload;
  payload["config"]["broadcast"]["self"] = false;
  payload["config"]["broadcast"]["ack"] = false;
  payload["config"]["presence"]["key"] = "";
  payload["config"]["private"] = false;
  payload["config"]["postgres_changes"].to<JsonArray>();
  payload["access_token"] = SUPABASE_ANON_KEY;
  rtJoinRef = String(rtRef + 1);
  String topic = "realtime:" + rtTopic;
  rtSend(topic.c_str(), "phx_join", payload, rtJoinRef);
}

void rtHandleText(const char* text, size_t len) {
  rtLastMessage = millis();
  JsonDocument doc;
  if (deserializeJson(doc, text, len)) return;
  const char* event = doc["event"] | "";

  if (strcmp(event, "phx_reply") == 0) {
    if (!rtJoined && rtJoinRef == (doc["ref"] | "")) {
      const char* status = doc["payload"]["status"] | "";
      if (strcmp(status, "ok") == 0) {
        rtJoined = true;
        fetchSoon = true;  // polecenia wysłane, gdy nie byliśmy połączeni
        Serial.println("Realtime: połączono, polecenia ze strony docierają natychmiast");
      } else {
        Serial.printf("Realtime: odmowa dołączenia do kanału (%s)\n", text);
      }
    }
  } else if (strcmp(event, "broadcast") == 0) {
    JsonObject cmd = doc["payload"]["payload"];
    long id = cmd["id"] | 0L;
    if (id <= 0 || wasHandled(id)) return;
    bool ok;
    runCommand(id, cmd["payload"].as<JsonVariantConst>(), cmd["created_at"].as<const char*>(), ok);
    if (ok) markHandled(id);
    fetchSoon = true;  // potwierdzenie w bazie przez device_fetch_commands + device_ack_command
  } else if (strcmp(event, "phx_error") == 0 || strcmp(event, "phx_close") == 0) {
    Serial.println("Realtime: kanał zamknięty, łączę ponownie");
    rtJoined = false;
    ws.disconnect();
  } else if (strcmp(event, "system") == 0 && strcmp(doc["payload"]["status"] | "", "error") == 0) {
    Serial.printf("Realtime: błąd kanału (%s)\n", text);
  }
}

void onWsEvent(WStype_t type, uint8_t* data, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("Realtime: WebSocket otwarty, dołączam do kanału");
      rtJoined = false;
      rtLastMessage = rtLastHeartbeat = millis();
      rtJoin();
      break;
    case WStype_DISCONNECTED:
      if (rtJoined) Serial.println("Realtime: rozłączono, ponawiam");
      rtJoined = false;
      break;
    case WStype_TEXT:
      rtHandleText((const char*)data, len);
      break;
    default:
      break;
  }
}

// Pobiera nazwę kanału z bazy i otwiera WebSocket. Dalej biblioteka sama wznawia połączenie.
void startRealtime() {
  if (rtStarted || WiFi.status() != WL_CONNECTED) return;
  unsigned long now = millis();
  if (rtTopicTry != 0 && now - rtTopicTry < TOPIC_RETRY_MS) return;
  rtTopicTry = now;

  JsonDocument body;
  body["p_key"] = DEVICE_KEY;
  String response;
  int code = callRpc("device_realtime_topic", body, response);
  JsonDocument doc;
  if (code != 200 || deserializeJson(doc, response) || !doc["topic"].is<const char*>()) {
    Serial.printf("Realtime: brak kanału (HTTP %d %s), zostaję przy odpytywaniu co 5 s\n", code, response.c_str());
    return;
  }
  rtTopic = doc["topic"].as<String>();

  String host = SUPABASE_URL;
  host.replace("https://", "");
  host.replace("/", "");
  String path = String("/realtime/v1/websocket?apikey=") + SUPABASE_ANON_KEY + "&vsn=1.0.0";
  ws.beginSslWithCA(host.c_str(), 443, path.c_str(), ROOT_CA, "");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(5000);
  rtStarted = true;
}

void realtimeLoop() {
  if (!rtStarted) return;
  ws.loop();
  if (!ws.isConnected()) return;
  unsigned long now = millis();
  if (now - rtLastHeartbeat >= HEARTBEAT_MS) {
    rtLastHeartbeat = now;
    JsonDocument payload;
    payload.to<JsonObject>();
    rtSend("phoenix", "heartbeat", payload, "");
  }
  if (now - rtLastMessage > SILENCE_LIMIT_MS) {
    Serial.println("Realtime: brak odpowiedzi serwera, łączę ponownie");
    rtJoined = false;
    rtLastMessage = now;
    ws.disconnect();
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
bool downloadFirmware(long long version, long size) {
  Serial.printf("OTA: pobieram wersję %lld (%ld B)...\n", version, size);
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
    Serial.printf("OTA: wersja %lld zapisana, uruchamiam ponownie\n", version);
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

  long long version = doc["version"] | 0LL;
  long size = doc["size"] | 0L;
  if (version <= FW_VERSION || size <= 0) return;

  // Ta sama wersja nie udała się już kilka razy (np. za duży plik): nie próbujemy w kółko.
  int tries = store.getLong64("fw_ver", 0) == version ? store.getInt("fw_tries", 0) : 0;
  if (tries >= FIRMWARE_MAX_TRIES) return;
  store.putLong64("fw_ver", version);
  store.putInt("fw_tries", tries + 1);

  if (!downloadFirmware(version, size) && tries + 1 >= FIRMWARE_MAX_TRIES) {
    Serial.printf("OTA: wersja %lld nie udała się %d razy, nie próbuję więcej. Wgraj nowszą.\n", version, FIRMWARE_MAX_TRIES);
  }
}

// ───────────── Dioda ─────────────

// Co BLINK_S zmienia stan diody. Gdy trwa przejście (tornOn), dioda świeci ciągle.
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

// Koniec przejścia: dioda wraca do zwykłego migania.
void turnOffLed() {
  tornOn = false;
  digitalWrite(LED_PIN, LOW);
}

// „Wyłącz przejście” ze strony: gasimy od razu i kasujemy odliczanie zabezpieczenia.
void stopPassage() {
  ledOffTicker.detach();
  turnOffLed();
}

// Zabezpieczenie: nikt nie kliknął „Wyłącz przejście” przez minutę.
void safetyOff() {
  Serial.println("Zabezpieczenie: minęła 1 minuta, wyłączam przejście");
  turnOffLed();
}

// „Uruchom przejście” ze strony: dioda świeci ciągle do „Wyłącz przejście”, najdłużej 1 minutę.
// Kolejne „Uruchom” liczy minutę od nowa.
void turnOnLed() {
  tornOn = true;
  digitalWrite(LED_PIN, HIGH);
  ledOffTicker.once(SAFETY_OFF_S, safetyOff);
}

// ───────────── Program ─────────────

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("CloudEA, wersja programu %lld (%s)\n", FW_VERSION, FW_TAG);
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
  startRealtime();
  realtimeLoop();
  unsigned long commandEvery = rtJoined ? COMMAND_INTERVAL_LIVE_MS : COMMAND_INTERVAL_MS;
  if (fetchSoon || now - lastCommandCheck >= commandEvery) {
    fetchSoon = false;
    lastCommandCheck = millis();
    checkCommands();
  }
  realtimeLoop();
  if (WiFi.status() == WL_CONNECTED &&
      (!firmwareChecked || now - lastFirmwareCheck >= FIRMWARE_INTERVAL_MS)) {
    firmwareChecked = true;
    lastFirmwareCheck = now;
    checkFirmware();
  }
  checkTouch();

  delay(50);
}
