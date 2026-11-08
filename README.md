# HukumIn Backend (NestJS)

REST API untuk aplikasi konsultasi hukum HukumIn: autentikasi, chatbot AI, pencarian pengacara, booking, ulasan, dan notifikasi.

## Teknologi
NestJS 11, TypeScript, TypeORM, JWT, bcryptjs, class-validator, Helmet, Throttler (rate limit), Swagger.
Database: SQLite (file lokal, tanpa instalasi) secara default, atau PostgreSQL lewat `DATABASE_URL`.

## Menjalankan
```bash
npm install
cp .env.example .env        # lalu isi JWT_SECRET (wajib)
npm run start:dev           # http://localhost:3000/api  |  dokumentasi: http://localhost:3000/docs
npm run test:e2e            # 9 tes end-to-end
npm run build && npm start  # mode produksi
```
Data 6 pengacara contoh (fiktif) otomatis dibuat saat database kosong.

## Chatbot AI
Isi `ANTHROPIC_API_KEY` di `.env` agar `POST /api/chat/messages` memanggil model AI. Tanpa key, backend membalas dengan teks contoh (mock) sehingga front end tetap bisa diuji.
API key hanya ada di server, tidak pernah di aplikasi Flutter. Aturan perilaku chatbot ada di `src/chat/ai.service.ts` (`SYSTEM_PROMPT`).

## Endpoint (prefix `/api`)
| Method | Path | Auth | Fungsi |
|---|---|---|---|
| GET | /health | - | Cek server |
| POST | /auth/register | - | Daftar (name, email, password min 8) |
| POST | /auth/login | - | Masuk, mengembalikan accessToken |
| GET | /auth/me | Ya | Profil pengguna |
| GET | /lawyers | - | Cari pengacara: q, specialty, city, minRating, maxPrice, sort (rating/price/experience), page, limit |
| GET | /lawyers/:id | - | Detail + 10 ulasan terbaru |
| POST | /lawyers/:id/reviews | Ya | Beri ulasan (rating 1-5), satu per pengguna |
| POST | /chat/messages | Ya | Kirim pesan (conversationId opsional); balasan AI + rekomendasi pengacara |
| GET | /chat/conversations | Ya | Daftar percakapan |
| GET | /chat/conversations/:id | Ya | Isi percakapan |
| DELETE | /chat/conversations/:id | Ya | Hapus percakapan |
| GET | /bookings/slots?lawyerId&date | Ya | Jam tersedia (YYYY-MM-DD) |
| POST | /bookings | Ya | Pesan konsultasi (lawyerId, date, time, type: video/voice/in_person, note) |
| GET | /bookings?status= | Ya | Daftar booking sendiri |
| PATCH | /bookings/:id/reschedule | Ya | Jadwal ulang |
| PATCH | /bookings/:id/cancel | Ya | Batalkan |
| GET | /notifications | Ya | Daftar + unreadCount |
| PATCH | /notifications/read-all | Ya | Tandai semua dibaca |

Header untuk endpoint yang butuh login: `Authorization: Bearer <accessToken>`.

## Menyambungkan Flutter
Tambahkan package `http` (atau `dio`), lalu ganti mock balasan AI di aplikasi dengan:
```dart
final res = await http.post(
  Uri.parse('$baseUrl/api/chat/messages'),
  headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
  body: jsonEncode({'conversationId': conversationId, 'message': text}),
);
final data = jsonDecode(res.body); // data['message']['content'], data['lawyers']
```
`baseUrl`: emulator Android memakai `http://10.0.2.2:3000`, Chrome/iOS simulator memakai `http://localhost:3000`.
Simpan token dengan `flutter_secure_storage`.

## Catatan keamanan dan batasan
- Atur `JWT_SECRET` acak dan panjang, dan `CORS_ORIGIN` ke domain aplikasi di produksi. Gunakan HTTPS (lewat reverse proxy).
- Rate limit: 100 permintaan/menit umum, 20/menit untuk chat, 10/menit untuk login/register.
- `synchronize: true` membuat tabel otomatis, nyaman untuk pengembangan. Di produksi gunakan migrasi TypeORM dan set `DB_SYNC=false`.
- Pembayaran, unggah lampiran, verifikasi email, dan reset password belum ada (belum diminta).
- Rekomendasi pengacara memakai pencocokan kata kunci sederhana (`lawyers.seed.ts`), bukan analisis AI.
- Zona waktu validasi tanggal booking memakai UTC.
- Data pengacara adalah contoh fiktif. Chatbot hukum hanya memberi informasi umum, bukan nasihat hukum resmi; pertahankan disclaimer di UI.

## Docker
```bash
docker build -t hukumin-backend .
docker run -p 3000:3000 -e JWT_SECRET=ganti-ini -e ANTHROPIC_API_KEY=... hukumin-backend
```
