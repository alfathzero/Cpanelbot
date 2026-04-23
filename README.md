# Cpanel by Alfa — Laporan Perbaikan Bug

  Tanggal analisis: 20 April 2026

  ---

  ## Ringkasan Fitur Utama

  - **Bot Telegram** berbasis Telegraf.js untuk manajemen panel Pterodactyl
  - **Sistem Role**: User → Premium → Reseller → Owner
  - **Manajemen Panel**: Buat/hapus/rename server Pterodactyl via bot
  - **Power Control**: Start / Stop / Restart server lewat bot
  - **Voucher & Referral**: Sistem voucher diskon + referral reward
  - **Tiket Support**: User bisa buka tiket, Owner bisa balas
  - **Auto Backup**: Backup panel otomatis terjadwal
  - **Web Dashboard**: Panel admin berbasis HTTP (Node.js)
  - **Monitoring**: Deteksi server down, resource overload, miner
  - **Whitelist/Blacklist**: Kontrol akses pengguna
  - **Maintenance Mode**: Jadwal maintenance otomatis
  - **Sistem Teman**: Berbagi panel antar akun
  - **Snapshot**: Simpan & restore state server
  - **Leaderboard**: Referral & poin
  - **Audit Log**: Rekam semua aksi penting

  ---

  ## Daftar Bug yang Diperbaiki

  ### Bug #1 — features.js: OWNER_IDS typo
  - **Sebelum**: `config.OWNER_ID` (tidak ada)
  - **Sesudah**: `config.OWNER_IDS` (sesuai config.js)
  - **Dampak**: Perintah owner tidak pernah berhasil, notifikasi owner tidak terkirim

  ### Bug #2 — index.js: isOwner type mismatch
  - **Sebelum**: `OWNER_IDS.includes(userId)` — ID numerik vs string dalam array
  - **Sesudah**: `.map(String).includes(String(userId))`
  - **Dampak**: Semua perintah owner selalu ditolak

  ### Bug #3 — index.js: addTransaction field salah
  - **Sebelum**: `db.addTransaction({ ..., name: '...' })`
  - **Sesudah**: Field `name` digabung ke `detail` yang memang ada di skema
  - **Dampak**: Error silent saat mencatat transaksi

  ### Bug #4 — database.js: daily_counts key collision
  - **Sebelum**: `daily_counts` key format `userId_date` — kolisi jika userId mengandung angka+underscore
  - **Sesudah**: Format `userId:date`
  - **Dampak**: Daily count tidak akurat untuk user dengan ID tertentu

  ### Bug #5 — database.js: saveDb tidak atomic
  - **Sebelum**: Write langsung ke file DB (data korup jika crash di tengah-tengah)
  - **Sesudah**: Write ke file temp lalu rename (atomic)
  - **Dampak**: Database bisa korup jika proses crash

  ### Bug #6 — database.js: baris duplikat
  - **Sebelum**: Ada baris kode yang tidak sengaja terduplikasi
  - **Sesudah**: Dihapus

  ### Bug #7 — dashboard.js: memory leak session
  - **Sebelum**: Session tidak punya TTL, tumbuh terus
  - **Sesudah**: TTL 24 jam + cleanup interval 30 menit
  - **Dampak**: Memory habis seiring waktu

  ### Bug #8 — dashboard.js: tidak ada brute force protection
  - **Sebelum**: Login bisa dicoba tanpa batas
  - **Sesudah**: 5 percobaan gagal = block 15 menit
  - **Dampak**: Rentan serangan brute force pada dashboard admin

  ### Bug #9 — dashboard.js: cookie tidak aman
  - **Sebelum**: Tidak ada SameSite attribute
  - **Sesudah**: `SameSite=Strict` + CSRF token
  - **Dampak**: Rentan CSRF attack

  ### Bug #10 — index.js: scheduled maintenance tidak cek hari
  - **Sebelum**: Field `days` dalam konfigurasi maintenance tidak pernah divalidasi
  - **Sesudah**: Ditambahkan pengecekan `config.SCHEDULED_MAINTENANCE.days`
  - **Dampak**: Maintenance jalan setiap hari meskipun seharusnya hanya hari tertentu

  ### Bug #11 — features.js: field panel salah di friend panels
  - **Sebelum**: `p.serverName`, `p.serverId`, `p.expireDate` (tidak ada)
  - **Sesudah**: `p.name`, `p.server_id`, `p.expire_date`
  - **Dampak**: Info panel teman tidak pernah tampil

  ### Bug #12 — features.js: field panel salah di bulk operations
  - **Sebelum**: `p.serverId` di semua bulk suspend/delete
  - **Sesudah**: `p.server_id`
  - **Dampak**: Bulk operations owner gagal semua

  ### Bug #13 — features.js: monitorAll menggunakan server_id salah
  - **Sebelum**: `p.serverId` di monitorAll dan scanMiners
  - **Sesudah**: `p.server_id`
  - **Dampak**: Monitoring tidak pernah bisa cek resource server

  ### Bug #14 — features.js: getServerResources menggunakan ID salah
  - **Sebelum**: `ptero.getServerResources(p.server_id)` — numeric ID tidak valid di client API
  - **Sesudah**: `ptero.getServerResources(p.server_identifier || p.server_id)`
  - **Dampak**: Monitoring resource selalu gagal (client API butuh identifier string, bukan numeric ID)

  ### Bug #15 — index.js: panel record tidak menyimpan ram/disk/cpu
  - **Sebelum**: `addPanelRecord` tidak menyimpan batas resource
  - **Sesudah**: Ditambahkan `ram: s.ram, disk: s.disk, cpu: s.cpu`
  - **Dampak**: checkOverResource tidak bisa bandingkan resource usage karena batas resource undefined

  ### Bug #16 — database.js: rate limit membaca/menulis DB setiap pesan
  - **Sebelum**: `checkRateLimit` memanggil `loadDb()` + `saveDb()` setiap request
  - **Sesudah**: Menggunakan in-memory Map, jauh lebih cepat
  - **Dampak**: Performa sangat lambat pada bot yang ramai; setiap pesan menulis file besar

  ---

  ## Catatan Penting

  1. **Konfigurasi**: Edit `config.js` sebelum menjalankan bot:
     - `BOT_TOKEN` — token dari @BotFather
     - `OWNER_IDS` — array Telegram ID owner
     - `PANEL_URL` — URL panel Pterodactyl
     - `PTLA_KEY` — Application API key
     - `PTLC_KEY` — Client API key
     - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — login dashboard
     - `SESSION_SECRET` — secret untuk session dashboard

  2. **Database**: Bot menggunakan file JSON (`db.json`) sebagai penyimpanan. Untuk produksi skala besar, pertimbangkan migrasi ke database nyata (SQLite/PostgreSQL).

  3. **Konkruensi**: Operasi read-modify-write pada db.json tidak thread-safe. Hindari menjalankan lebih dari satu instance bot secara bersamaan.

  ---

  ## Cara Menjalankan

  ```bash
  npm install
  node index.js
  ```

  Dashboard web tersedia di port yang dikonfigurasi dalam `config.js` (default: 3000).
  
  ---

  ## Perbaikan Tambahan (Sesi 2)

  ### Bug #17 — index.js: Cek resource tidak langsung jalan saat bot start
  - **Sebelum**: `checkOverResource` hanya dipanggil via `setInterval` — bot harus jalan 15 menit dulu sebelum cek pertama
  - **Sesudah**: Ditambahkan `setTimeout(checkOverResource, 2 menit)` agar cek berjalan 2 menit setelah bot start
  - **Dampak**: Owner menunggu terlalu lama sebelum notifikasi over-resource pertama kali terkirim

  ### Bug #18 — index.js: Tombol "Cek Resource" tidak mengirim notifikasi ke owner lain
  - **Sebelum**: Saat owner klik tombol "📊 Cek Resource" dan ada panel over-limit, hanya owner yang klik yang dapat laporan. Owner lain dan grup tidak diberitahu.
  - **Sesudah**: Setelah laporan ditampilkan, jika ada panel over-limit, notifikasi ringkasan dikirim ke semua owner (via config.OWNER_IDS + role owner) dan GROUP_ID
  - **Dampak**: Owner lain tidak tahu ada panel yang melebihi batas CPU/RAM/Disk

  ---

  ## Fitur Baru: Konfigurasi Warna Tombol

  ### Dashboard Web — `config.DASHBOARD_BUTTON_COLORS`
  Setiap jenis tombol di dashboard sekarang punya warna sendiri yang bisa dikustomisasi:

  | Tombol | Config Key | Warna Default | Keterangan |
  |--------|-----------|---------------|------------|
  | Utama/Filter | `primary` | Ungu `#6366f1` | Tombol umum/navigasi |
  | Aktifkan/Export | `success` | Hijau `#22c55e` | Aksi positif |
  | Hapus/Error | `danger` | Merah `#ef4444` | Aksi destruktif |
  | Suspend/Peringatan | `warning` | Kuning `#f59e0b` | Aksi hati-hati |
  | Detail/Lihat | `info` | Biru `#38bdf8` | Aksi informasi |
  | Tombol Login | `login` + `login2` | Ungu+Pink | Gradient tombol login |

  Contoh ubah tombol login jadi hijau:
  ```js
  DASHBOARD_BUTTON_COLORS: {
    login:  "#16a34a",
    login2: "#15803d",
    success: "#10b981",
    danger:  "#dc2626",
    // ... lainnya
  }
  ```

  ### Toggle Bot Telegram — `config.TOGGLE_EMOJI`
  Emoji untuk tombol ON/OFF di bot sekarang bisa dikustomisasi:

  ```js
  TOGGLE_EMOJI: {
    ON:  "🟢",   // emoji fitur AKTIF
    OFF: "🔴",   // emoji fitur NONAKTIF
  }
  ```

  Contoh ganti ke centang/silang:
  ```js
  TOGGLE_EMOJI: { ON: "✅", OFF: "❌" }
  ```

  > **Catatan**: Telegram tidak mendukung warna custom untuk tombol inline keyboard. Perbedaan visual di bot hanya bisa lewat emoji.
  