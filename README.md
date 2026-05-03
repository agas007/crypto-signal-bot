# Crypto Signal Bot

Crypto signal scanner berbasis **Node.js/JavaScript** dengan core strategy lama tetap dipertahankan. Repo ini sekarang punya jalur serverless untuk satu kali scan per request, cocok dipanggil cron eksternal seperti `cron-job.org`.

## Deteksi Tech Stack

- Runtime utama: **Node.js / JavaScript**
- Web layer: **Express** di root `server.js`
- Dashboard: **Next.js App Router** di `dashboard/`
- Package manager: **npm**
- Entry point legacy: `server.js`
- Entry point CLI one-shot: `src/run_once.js`
- Entry point serverless: `dashboard/src/app/api/check-signal/route.ts`
- Scheduler lama GitHub Actions: `.github/workflows/cron.yml` sudah dihapus
- Strategy: `src/modules/strategy/index.js`
- Signal generator / orchestrator: `src/modules/scanner/index.js`
- Discord notifier: `src/utils/discord.js`

## Arsitektur Baru

### Lama

- GitHub Actions menjalankan scanner tiap jam.
- Process legacy bisa hidup lama dengan `setInterval`.
- Discord dikirim dari proses background yang selalu aktif.

### Baru

- `cron-job.org` memanggil endpoint `GET /api/check-signal` setiap 1 jam.
- Endpoint menjalankan scan **sekali saja** lalu selesai dalam satu HTTP request.
- Redis Upstash dipakai untuk dedupe signal baru.
- Discord alert dikirim via **Discord Webhook**.

### Alur

1. Cron hit `/api/check-signal`
2. Endpoint validasi `CRON_SECRET`
3. Config existing diload
4. Scanner jalan sekali
5. Signal yang lolos dicek ke Upstash Redis
6. Kalau signal belum pernah dikirim untuk candle itu, alert dikirim ke Discord
7. JSON status dikembalikan ke caller

## File Penting

- `dashboard/src/app/api/check-signal/route.ts` - serverless endpoint
- `src/services/run_signal_check.js` - wrapper one-shot reusable
- `src/modules/scanner/index.js` - core scan logic
- `src/modules/strategy/index.js` - strategy existing
- `src/utils/discord.js` - Discord webhook formatter/sender
- `src/utils/signal_dedupe.js` - Upstash dedupe helper

## Environment Variables

### Wajib untuk endpoint

| Variable | Kegunaan |
|---|---|
| `CRON_SECRET` | Secret untuk validasi request cron |
| `DISCORD_WEBHOOK_URL` | Webhook Discord utama |
| `UPSTASH_REDIS_REST_URL` | URL REST Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Token Upstash Redis |
| `OPENROUTER_API_KEY` | AI validator / refinement |

### Existing env yang tetap dipakai

| Variable | Kegunaan |
|---|---|
| `OPENROUTER_MODEL` | Model OpenRouter |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | Private balance/trade data bila dipakai |
| `BYBIT_BASE_URLS` / `BYBIT_BASE_URL` | Fallback Bybit |
| `FUTURES_DATA_PROVIDER_ORDER` | Urutan provider market data futures |
| `FUTURES_DATA_ENABLE_HYPERLIQUID` | Toggle provider |
| `FUTURES_DATA_ENABLE_BINANCE_FALLBACK` | Fallback Binance futures |
| `ACCOUNT_BALANCE` | Basis risk existing |
| `MIN_RR_RATIO` | Minimum risk/reward existing |
| `MAX_PAIRS` | Batas pair scan existing |
| `SCAN_INTERVAL_MS` | Tetap ada sebagai config, tapi tidak dipakai untuk scheduler serverless |
| `LOG_LEVEL` | Level log |

### Legacy runtime optional

| Variable | Kegunaan |
|---|---|
| `ENABLE_LEGACY_SCANNER=1` | Mengaktifkan runtime long-running lokal lama |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Hanya untuk mode legacy lama |

## Install

```bash
npm install
```

## Jalankan Lokal

### Legacy web runtime

```bash
npm start
```

Default sekarang legacy scanner tidak jalan. Set `ENABLE_LEGACY_SCANNER=1` kalau memang mau mode lama yang persistent.

### One-shot manual

```bash
node src/run_once.js
```

## Deploy ke Vercel

Repo ini paling cocok dipisah per target:

1. **Dashboard Next.js**: deploy folder `dashboard/` sebagai project Vercel terpisah dan expose `app/api/check-signal/route.ts`
2. **Root Node app**: tetap dipakai hanya untuk legacy/local runtime kalau memang dibutuhkan

Langkah endpoint:

1. Import repo ke Vercel
2. Set env vars di atas
3. Pastikan `CRON_SECRET`, Redis, OpenRouter, dan Discord webhook terisi
4. Deploy

Kalau hanya butuh endpoint cron, deploy `dashboard/` sudah cukup.

## Setup cron-job.org

1. Buat job baru di cron-job.org
2. URL:
   - `https://<dashboard-vercel-domain>/api/check-signal`
3. Method:
   - `GET` atau `POST`
4. Header:
   - `Authorization: Bearer <CRON_SECRET>`
5. Schedule:
   - `5 * * * *`

Kenapa `5 * * * *`:

- Candle 1H sudah close dulu sebelum dicek
- Mengurangi risiko baca candle yang belum final

## Contoh Request Manual

```bash
curl -X GET "https://<domain>/api/check-signal" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Atau pakai query param:

```bash
curl "https://<domain>/api/check-signal?secret=$CRON_SECRET"
```

## Contoh Response

```json
{
  "ok": true,
  "status": "SIGNALS_SENT",
  "signalCount": 1,
  "durationMs": 12345,
  "report": {
    "status": "SIGNALS_SENT"
  }
}
```

## Test Manual

1. Request tanpa secret harus `401`
2. Request dengan secret valid dan tanpa signal harus tetap `200` dengan JSON valid
3. Kalau signal baru muncul, Discord harus menerima 1 pesan
4. Request ulang untuk candle yang sama harus kena dedupe Redis

## Catatan Arsitektur

- Trading strategy, indikator, TP/SL, risk management, pair/watchlist, dan format signal existing tidak diubah kecuali kebutuhan transport.
- Dedupe key:
  - `signal:{symbol}:{timeframe}:{side}:{candleTime}`
- TTL dedupe:
  - 7 hari
- Discord sekarang menggunakan webhook, bukan bot process yang harus online 24/7.
