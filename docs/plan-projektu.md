# Plan projektu: Portal dla ESP32

Cel: strona www z bazą danych, która odbiera dane z ESP32 i wysyła do niego małe paczki danych (rzędu kB), w całości na darmowych usługach.

## Proponowana architektura (koszt 0 zł)

- **Baza danych + API: Supabase (plan Free).** Postgres, gotowe REST API, logowanie użytkowników i Realtime. ESP32 rozmawia z bazą zwykłymi zapytaniami HTTPS, bez własnego serwera.
- **Strona www: GitHub Pages** (statyczna strona HTML/JS z biblioteką `supabase-js`), hostowana z tego repozytorium.
- **ESP32: Arduino IDE / PlatformIO**, biblioteki `WiFiClientSecure`, `HTTPClient`, `ArduinoJson`.
- **Kierunek ESP32 → strona:** ESP32 wysyła odczyty (`POST`) do tabeli `readings`.
- **Kierunek strona → ESP32:** strona zapisuje polecenie/dane do tabeli `commands`, ESP32 co kilka sekund pyta o nowe (`GET`), wykonuje je i oznacza jako odebrane.

Uwaga: darmowy projekt Supabase jest wstrzymywany po ok. 7 dniach bez aktywności. Regularne zapisy z ESP32 zwykle temu zapobiegają, a wstrzymany projekt można wznowić jednym kliknięciem.

## Kroki do realizacji

1. **Założenie kont i struktury repozytorium.** Konto Supabase (logowanie przez GitHub), nowy projekt w regionie EU (Frankfurt). W repo katalogi `web/`, `firmware/`, `supabase/` i opis w README.

2. **Projekt bazy danych.** Tabele:
   - `investments`: inwestycje (np. „Stare Juchy”) ze współrzędnymi do mapy,
   - `investment_photos`: galeria inwestycji (do 5 zdjęć, pliki w Supabase Storage),
   - `product_types` i `product_metrics`: typy produktów (AllinOne, Dale, Lite4, aktywne/pasywne doświetlenie, BikeDale) i dane, które każdy z nich może wysyłać,
   - `devices`: produkt w inwestycji; urządzenia łączące się ze stroną dostają automatycznie klucz `PL-123456789` wpisywany do kodu ESP32, a Lite4 i pasywne doświetlenie są tylko informacyjne (bez klucza),
   - `device_metrics`: które dane mają przychodzić z danego urządzenia na stronę,
   - `readings`: odczyty z ESP32 (JSON),
   - `commands`: dane dla ESP32 (do 8 kB) ze statusem: nowe / odebrane / wykonane / błąd.
   Migracja SQL w `supabase/migrations/`.

3. **Bezpieczeństwo i dostęp (RLS).** Włączenie Row Level Security na wszystkich tabelach. Strona działa tylko dla zalogowanego użytkownika (Supabase Auth, e‑mail). ESP32 nie dostaje klucza administracyjnego: korzysta z funkcji SQL (RPC), np. `device_push_reading(key, data)` i `device_fetch_commands(key)`, które sprawdzają `device_key`.

4. **Test API bez sprzętu.** Wywołanie funkcji RPC przez `curl` lub Postman: zapis odczytu, odczyt poleceń, zmiana statusu. Dzięki temu backend jest sprawdzony, zanim podłączymy ESP32.

5. **Firmware ESP32, część 1: Wi‑Fi i wysyłanie danych.** Połączenie z Wi‑Fi, HTTPS do Supabase (certyfikat główny CA w kodzie), cykliczne wysyłanie JSON z odczytami (np. temperatura, stan wejść), aktualizacja `last_seen`. Dane dostępowe w osobnym pliku `secrets.h` dodanym do `.gitignore`.

6. **Firmware ESP32, część 2: odbieranie danych ze strony.** Odpytywanie co 5–10 s o polecenia ze statusem „nowe”, parsowanie `ArduinoJson`, wykonanie (np. przełączenie wyjścia, zapis konfiguracji do pamięci flash przez `Preferences`/LittleFS), potwierdzenie statusem „wykonane”.

7. **Strona www, część 1: inwestycje i podgląd danych.** Prosta strona HTML/JS: logowanie, lista inwestycji, dodawanie inwestycji i produktów (z kluczem do skopiowania), zakładki: urządzenia ze statusem online/offline (na podstawie `last_seen`), odczyty z wykresem (Chart.js), galeria (do 5 zdjęć) i lokalizacja ze współrzędnymi i pinezką na mapie Polski (Leaflet + OpenStreetMap, darmowe).

8. **Strona www, część 2: wysyłanie danych do ESP32.** Formularz/edytor do tworzenia poleceń i małych paczek danych (z kontrolą rozmiaru, np. do 4 kB), historia poleceń z ich statusem. Opcjonalnie odświeżanie na żywo przez Supabase Realtime zamiast ręcznego odświeżania.

9. **Publikacja strony.** Wdrożenie na GitHub Pages przez GitHub Actions przy każdym pushu do `main`, skonfigurowanie adresów strony w ustawieniach Supabase Auth.

10. **Testy całości, utrzymanie i rozbudowa.** Test pełnego obiegu (ESP32 → baza → strona → ESP32), obsługa zaniku Wi‑Fi i ponowień, automatyczne czyszczenie starych odczytów (limit 500 MB bazy w planie Free). Na później: wiele urządzeń, aktualizacje firmware OTA, powiadomienia.

## Alternatywy (gdyby Supabase nie pasował)

- **Firebase Realtime Database (plan Spark)**: też darmowy, ma gotową bibliotekę dla ESP32, ale mniej wygodne zapytania i model NoSQL.
- **MQTT (np. HiveMQ Cloud Free) + baza**: najszybsza komunikacja w czasie rzeczywistym, ale więcej elementów do utrzymania.
