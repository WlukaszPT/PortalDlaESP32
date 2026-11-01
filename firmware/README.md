# Firmware ESP32

Program testowy `portal_esp32/portal_esp32.ino` (płytka ESP32 DevKit, Arduino IDE):

- co 5 minut zwiększa `counter` (od 7:00 do 19:00 o 1, od 19:00 do 7:00 o 0,3) i losuje `napiecie` (11,8–13,2 V), a potem wysyła je do bazy jako „Ilość uruchomień” (w całościach, np. 23,3 jako 23) i „Napięcie akumulatora”,
- o północy (czas polski pobierany z internetu) zeruje `counter`,
- `counter` zapisuje w pamięci flash, więc po restarcie albo zaniku zasilania liczy dalej (chyba że w międzyczasie minęła północ),
- trzyma **stałe połączenie** (WebSocket z Supabase Realtime), więc przycisk **Uruchom przejście** w zakładce Urządzenia od razu ustawia `tornOn = true` i zapala wbudowaną niebieską diodę (GPIO2), a **Wyłącz przejście** od razu ją gasi,
- **zabezpieczenie czasowe**: jeśli po „Uruchom przejście” nikt nie kliknie „Wyłącz”, dioda gaśnie sama po 1 minucie (`SAFETY_OFF_S`); kolejne „Uruchom” liczy minutę od nowa,
- dodatkowo pyta bazę o polecenia co 30 s (bez połączenia Realtime co 5 s), na wypadek gdyby coś nie dotarło przez WebSocket; polecenie „włącz” starsze niż minuta (np. wysłane, gdy płytka była wyłączona) jest pomijane.
- po dotknięciu palcem pinu dotykowego **D4 (GPIO4, T0)** pobiera z bazy **Wiadomość serwera** (zakładka w inwestycji na stronie) i wypisuje ją w monitorze portu szeregowego (nie przechowuje jej w pamięci, przy każdym dotyku pobiera od nowa), np. `>>> Wiadomość serwera: Zachowaj ostrożność`. Jeden dotyk = jeden komunikat; kolejny po zabraniu palca. Podczas startu płytki nie dotykaj tego pinu (program mierzy wtedy jego wartość spoczynkową).

- wbudowana dioda (GPIO2) reaguje tylko na przyciski na stronie: świeci podczas przejścia (do „Wyłącz” albo najdłużej 1 minutę), poza tym jest zgaszona; miga szybko (co 0,1 s) tylko podczas pobierania nowego programu,
- co minutę pyta stronę (`device_check_firmware`), czy w zakładce **Firmware** jest nowsza wersja niż wkompilowana `FW_VERSION` (data kompilacji); jeśli tak, pobiera plik .bin przez HTTPS (funkcja `device-firmware`), zapisuje go we flashu i uruchamia się ponownie. Jedna wersja jest próbowana najwyżej 3 razy.

## Zdalna aktualizacja (OTA)

ESP32 nie kompiluje kodu, dlatego na stronę wgrywa się **skompilowany plik .bin**, a nie .ino (.ino można dołączyć jako kopię źródła).

1. Numeru wersji nie trzeba zmieniać: program liczy go sam z daty i godziny kompilacji (`RRMMDDGGMM`, np. `2610311838` = 31.10.2026, 18:38), więc każdy nowy eksport ma wyższy numer.
2. Arduino IDE: **Szkic → Eksportuj skompilowany plik binarny**. Plik `portal_esp32.ino.bin` pojawi się w folderze szkicu (albo w `build/esp32.esp32.esp32doit-devkit-v1/`). Nie bierz plików z `bootloader`, `partitions` ani `merged` w nazwie.
3. Strona → inwestycja → **Firmware** → wybierz urządzenie i dodaj plik .bin. Strona sama odczyta numer wersji z pliku i sprawdzi, czy jest w nim klucz tego urządzenia.
4. W ciągu minuty ESP32 pobierze program i uruchomi się ponownie; w zakładce widać wersję zgłoszoną przez urządzenie.

Schemat partycji (Narzędzia → Partition Scheme) musi mieć dwa miejsca na program: domyślny „Default 4MB with spiffs” (program do 1,25 MB) albo, gdy program jest większy, „Minimal SPIFFS (1.9MB APP with OTA)”. Pierwszy program z tą funkcją wgrywa się kablem USB; zmiana schematu partycji też wymaga kabla. Nowy program przed wysłaniem na stronę warto sprawdzić na płytce przez USB: jeśli nie połączy się z Wi‑Fi, zdalnie już się go nie poprawi.

## Uruchomienie

1. Arduino IDE: Plik → Preferencje → „Dodatkowe adresy URL menedżera płytek”: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, potem Menedżer płytek → zainstaluj **esp32** (Espressif).
2. Menedżer bibliotek → zainstaluj **ArduinoJson** (Benoit Blanchon, wersja 7) oraz **WebSockets** (Markus Sattler, wersja 2.6 lub nowsza).
3. Skopiuj `portal_esp32/secrets.example.h` jako `portal_esp32/secrets.h` i wpisz: nazwę i hasło Wi‑Fi, adres i klucz anon Supabase (Project Settings → API) oraz klucz urządzenia ze strony (np. `PL-901292632`).
4. Otwórz `portal_esp32/portal_esp32.ino`, wybierz płytkę **ESP32 Dev Module** i port, kliknij Wgraj.
5. Monitor portu szeregowego (115200) pokazuje wysyłane odczyty i odebrane polecenia.

Plik `secrets.h` jest w `.gitignore` i nie trafia do repozytorium. `root_ca.h` zawiera publiczne certyfikaty główne, dzięki którym połączenie HTTPS z Supabase jest sprawdzane.
