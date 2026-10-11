# Firmware ESP32

Program testowy `portal_esp32/portal_esp32.ino` (płytka ESP32 DevKit, Arduino IDE):

- co 20 s zwiększa `counter` o 1 i losuje `napiecie` (11,8–13,2 V), a potem wysyła je do bazy jako „Ilość uruchomień” i „Napięcie akumulatora”,
- co 5 s sprawdza polecenia; przycisk **Uruchom przejście** w zakładce Urządzenia ustawia `tornOn = true` i ESP32 zapala wbudowaną diodę na 10 s.

## Uruchomienie

1. Arduino IDE: Plik → Preferencje → „Dodatkowe adresy URL menedżera płytek”: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, potem Menedżer płytek → zainstaluj **esp32** (Espressif).
2. Menedżer bibliotek → zainstaluj **ArduinoJson** (Benoit Blanchon, wersja 7).
3. Skopiuj `portal_esp32/secrets.example.h` jako `portal_esp32/secrets.h` i wpisz: nazwę i hasło Wi‑Fi, adres i klucz anon Supabase (Project Settings → API) oraz klucz urządzenia ze strony (np. `PL-901292632`).
4. Otwórz `portal_esp32/portal_esp32.ino`, wybierz płytkę **ESP32 Dev Module** i port, kliknij Wgraj.
5. Monitor portu szeregowego (115200) pokazuje wysyłane odczyty i odebrane polecenia.

Plik `secrets.h` jest w `.gitignore` i nie trafia do repozytorium. `root_ca.h` zawiera publiczne certyfikaty główne, dzięki którym połączenie HTTPS z Supabase jest sprawdzane.
