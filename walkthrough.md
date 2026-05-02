# 🚀 Setup Guide: Discord + GitHub Actions + Cloudflare Workers

## Overview Arsitektur

```
GitHub Actions (cron) → scan → kirim signal → Discord Webhook
                                      ↕ state
                               Upstash Redis
                                      ↕ read
Cloudflare Worker ← /active /history /lessons /watchlist /status
```

---

## Step 1: Buat Discord Bot & Server

1. Buka https://discord.com/developers/applications
2. **New Application** → kasih nama misal "Crypto Signal Bot"
3. Catat **Application ID** (di halaman General Information)
4. Ke tab **Bot** → **Add Bot**
5. Di bawah Token → **Reset Token** → catat **Bot Token**
6. Di tab **Bot** → scroll ke bawah → aktifkan:
   - ✅ `Server Members Intent`
7. Ke tab **OAuth2 → URL Generator**:
   - Scopes: ✅ `bot`, ✅ `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Attach Files`
   - Copy URL → buka di browser → add bot ke server lo
8. Di Discord server, buat 2 channel:
   - `#signals` — untuk sinyal trading
   - `#status` — untuk status/notifikasi (opsional, bisa sama)

---

## Step 2: Buat Discord Webhooks

1. Klik kanan channel `#signals` → **Edit Channel** → **Integrations** → **Webhooks**
2. **New Webhook** → kasih nama → **Copy Webhook URL**
3. Simpan URL ini sebagai `DISCORD_SIGNAL_WEBHOOK_URL`
4. (Opsional) Buat webhook kedua untuk `#status` → simpan sebagai `DISCORD_STATUS_WEBHOOK_URL`

---

## Step 3: Setup Upstash Redis

1. Buka https://upstash.com → Sign up (gratis, no credit card)
2. **Create Database** → pilih region terdekat (Singapore / ap-southeast-1)
3. Setelah dibuat, buka database → tab **REST API**
4. Copy:
   - `UPSTASH_REDIS_REST_URL` (format: `https://xxxx.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN`

---

## Step 4: Setup GitHub Secrets

Di repo GitHub → **Settings → Secrets and variables → Actions → New repository secret**

Tambahkan semua secrets ini:

| Secret Name | Value |
|-------------|-------|
| `UPSTASH_REDIS_REST_URL` | dari Step 3 |
| `UPSTASH_REDIS_REST_TOKEN` | dari Step 3 |
| `DISCORD_SIGNAL_WEBHOOK_URL` | dari Step 2 |
| `DISCORD_STATUS_WEBHOOK_URL` | dari Step 2 (bisa sama) |
| `OPENROUTER_API_KEY` | API key lo |
| `OPENROUTER_MODEL` | e.g. `openai/gpt-4o-mini` |
| `BINANCE_API_KEY` | opsional, untuk balance check |
| `BINANCE_API_SECRET` | opsional |
| `ACCOUNT_BALANCE` | e.g. `4` |

Tambahkan **Variables** (bukan secret, bisa dilihat):

| Variable | Value |
|----------|-------|
| `MIN_RR_RATIO` | `1.5` |
| `MAX_PAIRS` | `30` |

---

## Step 5: Deploy Cloudflare Worker (Slash Commands)

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login ke Cloudflare
wrangler login

# Masuk ke directory worker
cd cloudflare-worker

# Set secrets
wrangler secret put DISCORD_PUBLIC_KEY
# → paste Public Key dari Discord Dev Portal (tab General Information)

wrangler secret put UPSTASH_REDIS_REST_URL
# → paste URL dari Upstash

wrangler secret put UPSTASH_REDIS_REST_TOKEN
# → paste token dari Upstash

# Deploy worker
wrangler deploy
# → catat URL yang muncul, e.g.: https://crypto-bot-discord.xxx.workers.dev
```

---

## Step 6: Set Interactions Endpoint di Discord

1. Buka Discord Developer Portal → aplikasi lo
2. Tab **General Information**
3. **Interactions Endpoint URL** → isi dengan URL worker dari Step 5
4. Klik **Save Changes** → Discord akan test endpoint lo (harus return 200)

---

## Step 7: Register Slash Commands

```bash
cd cloudflare-worker

# Set env vars sementara
export DISCORD_BOT_TOKEN="Bot token dari Step 1"
export DISCORD_APP_ID="Application ID dari Step 1"

# Register commands
node scripts/register.js
```

Output yang benar:
```
✅ Registered 5 commands successfully:
  /active — ⏳ List all currently active trade signals
  /history — 📜 View last 10 trade results
  /lessons — 🧠 View recent AI post-mortem lessons
  /watchlist — 📡 View last scan cycle high-alert watchlist
  /status — 📊 Bot health info
```

---

## Step 8: Test!

### Test manual trigger:
1. GitHub repo → tab **Actions**
2. **Crypto Signal Bot — Cron Scanner** → **Run workflow**
3. Lihat log di GitHub Actions
4. Cek channel Discord — sinyal harus masuk

### Test slash commands:
1. Di Discord server lo → ketik `/active`
2. Bot harus reply dengan list active signals

---

## Troubleshooting

**GitHub Actions gagal install Chrome:**
```yaml
# Di cron.yml, tambahkan ini jika perlu:
- name: Debug Chrome path
  run: which google-chrome || which chromium
```

**Discord Webhook tidak terima pesan:**
- Pastikan `DISCORD_SIGNAL_WEBHOOK_URL` sudah di-set di GitHub Secrets
- Test manual: `curl -X POST $WEBHOOK_URL -H "Content-Type: application/json" -d '{"content":"test"}'`

**Slash commands tidak muncul:**
- Tunggu 1-2 menit setelah register (global commands propagation)
- Pastikan bot sudah di-invite ke server dengan scope `applications.commands`

**Worker error 401 (Invalid signature):**
- Pastikan `DISCORD_PUBLIC_KEY` di wrangler secret sudah benar (bukan Bot Token, tapi Public Key)

---

## Cron Schedule Reference

```yaml
# Di cron.yml, ubah sesuai kebutuhan:
- cron: '0 * * * *'    # Setiap jam (default)
- cron: '0 */2 * * *'  # Setiap 2 jam
- cron: '0 2,8,14,20 * * *'  # 4x sehari (09:00, 15:00, 21:00, 03:00 WIB)
```

> **Catatan:** GitHub Actions cron bisa delay 5-30 menit saat traffic tinggi. Ini normal.
