# Komunikacja ESP32 ↔ baza

ESP32 nie ma dostępu do tabel. Rozmawia z bazą tylko przez cztery funkcje, podając swój klucz `PL-123456789`.

Każde wywołanie to `POST {SUPABASE_URL}/rest/v1/rpc/<funkcja>` z nagłówkami:

```
apikey: <SUPABASE_ANON_KEY>
Content-Type: application/json
```

| Funkcja | Treść (JSON) | Odpowiedź |
|---|---|---|
| `device_get_config` | `{"p_key": "PL-123456789"}` | `{"metrics": [{"key": "battery_voltage", "type": "number", "allowed": null}, ...]}`: dane włączone na stronie |
| `device_push_reading` | `{"p_key": "...", "p_data": {"battery_voltage": 12.6, "activations": 15}}` | `{"accepted": [...], "rejected": [...]}` |
| `device_fetch_commands` | `{"p_key": "..."}` | `[{"id": 1, "payload": {...}, "created_at": "..."}]`: nowe polecenia, oznaczane jako odebrane |
| `device_ack_command` | `{"p_key": "...", "p_command_id": 1, "p_ok": true, "p_result": "ok"}` | pusta (204) |
| `device_realtime_topic` | `{"p_key": "..."}` | `{"topic": "cloudea-<uuid>"}`: tajna nazwa kanału Realtime tego urządzenia |

Zasady:

- Każde wywołanie z poprawnym kluczem aktualizuje `last_seen` (status online na stronie).
- Odczyt: maks. 4 kB, najwyżej jeden na 10 sekund. Zapisywane są tylko dane włączone dla urządzenia i o poprawnym typie (`integer`, `number`, `text` do 200 znaków, `enum` z listy).
- Polecenia: maks. 10 na raz, w kolejności dodania. Po wykonaniu ESP32 potwierdza je przez `device_ack_command`.
- Zły klucz lub urządzenie informacyjne (Lite4, aktywne/pasywne doświetlenie) zwraca błąd 403.

## Stałe połączenie (Supabase Realtime)

Żeby polecenia ze strony docierały od razu, ESP32 trzyma otwarty WebSocket z Realtime:

1. `device_realtime_topic` zwraca nazwę kanału (losowy identyfikator w tabeli `device_channels`, niewidoczny na stronie ani dla zalogowanych).
2. ESP32 łączy się z `wss://<projekt>.supabase.co/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0` i wysyła
   `{"topic": "realtime:<kanał>", "event": "phx_join", "payload": {"config": {"broadcast": {"self": false}, "private": false}}, "ref": "1", "join_ref": "1"}`,
   a potem co 25 s `{"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": "N"}`.
3. Nowy wiersz w `commands` wyzwalacz `commands_broadcast` od razu wysyła na kanał (`realtime.send`) jako zdarzenie `command`:
   `{"event": "broadcast", "payload": {"event": "command", "payload": {"id": 5, "payload": {"turn on": true}, "created_at": "..."}}}`.
4. ESP32 wykonuje polecenie od razu, a potem potwierdza je zwykłą drogą (`device_fetch_commands` + `device_ack_command`). Bez połączenia Realtime nadal odpytuje bazę co 5 s, przy połączeniu co 30 s (zapas).

Polecenia przejścia: `{"turn on": true}` (Uruchom przejście, dioda świeci, najdłużej 1 minutę – potem ESP32 gasi ją sam) i `{"turn off": true}` (Wyłącz przejście). Polecenie „włącz” starsze niż 1 minuta (np. wysłane, gdy ESP32 było wyłączone) jest pomijane i oznaczane jako błąd.
