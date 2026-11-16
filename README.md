# Harles Studio — Audio Speed & Roblox Open Cloud Uploader

Web tool pribadi & share-ready tanpa library eksternal:
- **Lokal di Windows (Tanpa Install):** Pakai [start-harles-studio.bat](start-harles-studio.bat) (`server.ps1` PowerShell bawaan Windows + Web Audio API).
- **Online 24/7 di Cloud (Untuk Kirim Link ke Teman):** Pakai `server.js` (Node.js murni `>=18`, **0 dependencies**) yang siap di-deploy ke **Render** atau **Railway**.

## Fitur Utama
- **Multi-File Batch Upload:** Drag & drop banyak file audio (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`) sekaligus.
- **Live Audio Preview + Waveform:** Putar langsung rekaman/audio kamu sembari mengatur **Playback Speed (`0.50x` – `2.50x`)** dan toggle **Preserve Pitch**.
- **Export & Download:** Download file hasil perubahan kecepatan langsung dari browser (otomatis menyesuaikan kualitas agar tetap di bawah batas 20 MB Roblox bila perlu).
- **Auto-Upload ke Roblox Open Cloud API:** Pilih target **Akun Pribadi (`User ID`)** atau **`Group ID`**, edit `displayName` tiap aset, lalu upload satu per satu atau batch sekaligus dan dapatkan `rbxassetid://...`.
- **Aman untuk Dibagi (BYOK Shared Mode):** Saat di-deploy ke cloud (`RENDER`/`RAILWAY`), diakses dari HP, WiFi LAN, atau link tunnel publik, server otomatis mengunci `.env` pemilik (`APP_MODE=shared`) dan meminta setiap pengguna memasukkan API Key & ID mereka masing-masing di browser (`sessionStorage`).

---

## Cara Deploy 24/7 ke Internet (Bisa Kirim Link ke Teman!)

### Opsi A — Deploy Gratis ke Render (`render.yaml` sudah siap!)
1. Upload isi folder `harles-studio` ini ke repository **GitHub** (file `.env` otomatis terabaikan oleh `.gitignore`).
2. Login ke [render.com](https://render.com) → klik **New +** → pilih **Blueprint** (atau **Web Service**).
3. Hubungkan repository GitHub-mu:
   - **Runtime:** `Node`
   - **Build Command:** *(kosongkan saja, tidak perlu `npm install`)*
   - **Start Command:** `node server.js`
   - **Environment Variable:** `APP_MODE=shared` (sudah otomatis di `render.yaml`)
4. Setelah deploy selesai, kamu langsung dapat link permanen seperti `https://harles-studio.onrender.com` untuk dikirim ke teman dan dibuka dari HP 24/7!

### Opsi B — Deploy ke Railway
1. Hubungkan repository GitHub yang sama ke **Railway** (atau lewat plugin Railway di Antigravity).
2. Railway otomatis menjalankan `npm start` (`node server.js`) tanpa perlu menginstal dependensi tambahan.
3. Tambahkan variable `APP_MODE=shared` lalu generate public domain di tab **Settings → Networking**.

---

## Cara Menjalankan Lokal di Windows (Tanpa Install Node.js)
- **Pemakaian Pribadi:** Klik dua kali **`start-harles-studio.bat`** → buka `http://127.0.0.1:3456`.
- **Link Sementara via Cloudflare Quick Tunnel:** Jalankan **`start-share-mode.bat`**, lalu jalankan `cloudflared tunnel --url http://127.0.0.1:3456`.
- **Dari HP Satu WiFi (LAN):** Jalankan **`start-lan-wifi.bat`** lalu buka alamat `http://<IP-WiFi-PC>:3456/` di browser HP.
- **Kirim ZIP Bersih ke Teman:** Jalankan **`build-share-zip.bat`** untuk menghasilkan `harles-studio-untuk-teman.zip` tanpa file `.env`.

---

## Batasan Resmi Audio Roblox Open Cloud
- Format didukung: `.mp3`, `.ogg`, `.wav`, `.flac`
- Ukuran maksimal: **20 MB**
- Durasi maksimal: **7 menit** (setelah kecepatan diubah)
- Sample rate: <= 48 kHz
- Biaya: **Gratis (0 Robux)** dengan kuota **10 audio/bulan** (non-ID-verified) atau **100 audio/bulan** (ID-verified).
