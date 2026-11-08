# Dataset Chatbot HukumIn

Backend membaca dataset ini secara otomatis setiap kali server start
(`LegalQaService` → `src/chat/legal-qa.service.ts`).

## File yang perlu diletakkan di sini

| File | Isi | Kolom yang dipakai |
|------|-----|--------------------|
| `Indonesian_Legal_QA_543_Baris.csv` | 543 baris QA hukum | `Title`, `Link`, `Question`, `Answer`, `kategori` |
| `dataset_klasifikasi_kasus_hukum_500.csv` | 500 baris laporan kasus | `teks_laporan`, `kategori` |

Kedua file tersebut adalah sumber data yang dipakai notebook
**`gabungan dataset.ipynb`** (di-*upload* manual saat menjalankan notebook di Google Colab).
Salin keduanya dari Google Drive / folder lokal Anda ke folder `backend/data/` ini,
lalu **restart backend**.

Nama file boleh berbeda — backend mendeteksi file CSV di folder `data/` berdasarkan
**nama kolomnya**, bukan nama file. Kalau ingin memaksa path tertentu, isi
`CHAT_QA_DATASET_PATH` dan `CHAT_CLASSIFICATION_DATASET_PATH` di `.env`.

## Cara memverifikasi

```bash
# status dataset (butuh token JWT)
curl http://localhost:3000/api/chat/dataset -H "Authorization: Bearer <token>"
```

Jawaban yang sukses:

```json
{
  "ready": true,
  "primary": true,
  "qaRows": 543,
  "classificationRows": 500,
  "categories": ["Pencurian", "Pencemaran Nama Baik", "Penganiayaan", "Penipuan dan Penggelapan"],
  "mode": "dataset"
}
```

## Cara kerja algoritma (sama dengan notebook)

1. **Deteksi intent** — `sapaan` / `konsultasi` / `rekomendasi_advokat` / `laporan`.
2. **Klasifikasi kategori** — TF-IDF (`lowercase`, `ngram_range=(1,2)`, `sublinear_tf=True`)
   + multinomial logistic regression (pengganti LinearSVC dari notebook, akurasi ~99%).
3. **Pencarian jawaban** — cosine similarity TF-IDF atas teks `Title + Question + Answer`,
   difilter ke kategori hasil klasifikasi.
4. **Ambang** — `CHAT_SIMILARITY_THRESHOLD` (default `0.02`, sama dengan `BATAS_KEMIRIPAN`).
5. **Format jawaban** — sama persis dengan output `chatbot()` pada notebook.

## Mode jawaban

| `CHAT_ANSWER_MODE` | Perilaku |
|--------------------|----------|
| `dataset` (default) | Jawaban diambil langsung dari dataset. Tidak butuh API key. |
| `ai` | AI eksternal (Anthropic/OpenAI-compatible) merangkai jawaban **hanya** dari dataset sebagai konteks. |

## Cadangan

`chatbot-dataset.json` (10 entri contoh) dipakai sebagai fallback bila file CSV belum
dipasang. Cek `hint` pada `/api/chat/dataset` untuk memastikan dataset gabungan aktif.
