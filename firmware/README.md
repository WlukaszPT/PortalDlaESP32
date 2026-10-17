# Firmware ESP32

Program testowy `portal_esp32/portal_esp32.ino` (płytka ESP32 DevKit, Arduino IDE):

- co 20 s zwiększa `counter` (od 7:00 do 19:00 o 1, od 19:00 do 7:00 o 0,3) i losuje `napiecie` (11,8–13,2 V), a potem wysyła je do bazy jako „Ilość uruchomień” (w całościach, np. 23,3 jako 23) i „Napięcie akumulatora”,
- o północy (czas polski pobierany z internetu) zeruje `counter`,
- `counter` zapisuje w pamięci flash, więc po restarcie albo zaniku zasilania liczy dalej (chyba że w międzyczasie minęła północ),
- co 5 s sprawdza polecenia; przycisk **Uruchom przejście** w zakładce Urządzenia ustawia `tornOn = true`, a wbudowana niebieska dioda (GPIO2) świeci wtedy 10 s.
- po dotknięciu palcem pinu dotykowego **D4 (GPIO4, T0)** pobiera z bazy **Wiadomość serwera** (zakładka w inwestycji na stronie) i wypisuje ją w monitorze portu szeregowego (nie przechowuje jej w pamięci, przy każdym dotyku pobiera od nowa), np. `>>> Wiadomość serwera: Zachowaj ostrożność`. Jeden dotyk = jeden komunikat; kolejny po zabraniu palca. Podczas startu płytki nie dotykaj tego pinu (program mierzy wtedy jego wartość spoczynkową).

## Uruchomienie

1. Arduino IDE: Plik → Preferencje → „Dodatkowe adresy URL menedżera płytek”: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, potem Menedżer płytek → zainstaluj **esp32** (Espressif).
2. Menedżer bibliotek → zainstaluj **ArduinoJson** (Benoit Blanchon, wersja 7).
3. Skopiuj `portal_esp32/secrets.example.h` jako `portal_esp32/secrets.h` i wpisz: nazwę i hasło Wi‑Fi, adres i klucz anon Supabase (Project Settings → API) oraz klucz urządzenia ze strony (np. `PL-901292632`).
4. Otwórz `portal_esp32/portal_esp32.ino`, wybierz płytkę **ESP32 Dev Module** i port, kliknij Wgraj.
5. Monitor portu szeregowego (115200) pokazuje wysyłane odczyty i odebrane polecenia.

Plik `secrets.h` jest w `.gitignore` i nie trafia do repozytorium. `root_ca.h` zawiera publiczne certyfikaty główne, dzięki którym połączenie HTTPS z Supabase jest sprawdzane.
