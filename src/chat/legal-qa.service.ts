import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

/**
 * Port logika "gabungan dataset.ipynb" (Colab) ke backend NestJS.
 *
 * Notebook aslinya memakai:
 *   - df_klasifikasi : 500 baris -> kolom: index, teks_laporan, kategori
 *   - df_qa           : 543 baris -> kolom: Title, Link, Question, Answer, kategori
 *   - TfidfVectorizer(lowercase=True, ngram_range=(1,2), sublinear_tf=True)
 *   - LinearSVC untuk klasifikasi kategori (di sini digantikan multinomial logistic
 *     regression dengan feature TF-IDF yang sama, hasil praktis identik)
 *   - cosine_similarity + BATAS_KEMIRIPAN = 0.02
 *
 * Retrieval ditingkatkan: pencarian dibobot (title/Question > Answer), exact/phrase
 * match, dan fallback global agar pertanyaan spesifik selalu mengenai entri QA paling tepat.
 *
 * File CSV asli dibaca otomatis dari folder `data/` (lihat data/README.md).
 */

export interface QaRow {
  id: string;
  title: string;
  link: string;
  question: string;
  answer: string;
  /** kategori bisa berisi lebih dari satu label, dipisah tanda titik koma ";" */
  categories: string[];
  searchText: string;
  normTitle: string;
  normQuestion: string;
  normAnswer: string;
  normAll: string;
  tokenSet: Set<string>;
}

export interface ClassificationRow {
  text: string;
  category: string;
}

export interface DatasetHit {
  row: QaRow;
  score: number;
}

export type LegalIntent = 'sapaan' | 'konsultasi' | 'rekomendasi_advokat' | 'laporan' | 'kosong';

export interface LegalQaResult {
  /** Balasan final siap tampil (mengikuti format notebook). */
  reply: string;
  intent: LegalIntent;
  /** Kategori hasil klasifikasi (null bila dataset klasifikasi tidak tersedia). */
  category: string | null;
  /** Skor kemiripan 0..1 dari cosine similarity TF-IDF. */
  score: number;
  /** Link sumber (hukumonline) dari dataset. */
  link: string | null;
  /** Pertanyaan terkait yang terpilih. */
  question: string | null;
  /** Hit teratas, berguna untuk konteks AI. */
  hits: DatasetHit[];
}

export interface LegalQaStatus {
  ready: boolean;
  /** true bila dataset CSV gabungan aktif (bukan dataset contoh). */
  primary: boolean;
  qaRows: number;
  classificationRows: number;
  categories: string[];
  qaPath: string | null;
  classificationPath: string | null;
  similarityThreshold: number;
  answerMaxChars: number;
  loadedAt: number | null;
  hint: string | null;
}

const DEFAULT_THRESHOLD = 0.02;

@Injectable()
export class LegalQaService implements OnModuleInit {
  private readonly logger = new Logger(LegalQaService.name);

  private qaRows: QaRow[] = [];
  private classificationRows: ClassificationRow[] = [];
  private categories: string[] = [];

  // Indeks TF-IDF untuk pencarian kemiripan (dibobot per field: title/question/answer).
  private qaIdf = new Map<string, number>();
  private qaVectors: Array<Map<string, number>> = [];
  // Indeks TF-IDF + bobot klasifikasi.
  private clsIdf = new Map<string, number>();
  private clsWeights: number[][] = [];
  private clsLabels: string[] = [];
  private termIndex = new Map<string, number>();
  private debug = false;

  private qaPath = '';
  private classificationPath = '';
  private loadedAt: number | null = null;
  private threshold = DEFAULT_THRESHOLD;
  private answerMaxChars = 1500;
  /** true bila sumber dataset adalah CSV gabungan (bukan dataset contoh JSON). */
  private primary = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.reload();
  }

  // ── Status ────────────────────────────────────────────────
  getStatus(): LegalQaStatus {
    const missing: string[] = [];
    if (!this.primary) missing.push('dataset Legal QA (Indonesian_Legal_QA_543_Baris.csv)');
    if (!this.classificationRows.length) missing.push('dataset klasifikasi (dataset_klasifikasi_kasus_hukum_500.csv)');
    return {
      ready: this.primary && this.qaRows.length > 0,
      primary: this.primary,
      qaRows: this.qaRows.length,
      classificationRows: this.classificationRows.length,
      categories: this.categories,
      qaPath: this.qaPath || null,
      classificationPath: this.classificationPath || null,
      similarityThreshold: this.threshold,
      answerMaxChars: this.answerMaxChars,
      loadedAt: this.loadedAt,
      hint: missing.length
        ? `Dataset gabungan belum lengkap. Letakkan file berikut di folder data/ lalu restart backend: ${missing.join(' dan ')}. `
          + 'Detail ada di backend/data/README.md.'
        : null,
    };
  }

  get hasDataset() {
    return this.qaRows.length > 0;
  }

  /** True bila dataset CSV gabungan (Legal QA + klasifikasi) sudah terpasang. */
  get hasPrimaryDataset() {
    return this.primary && this.qaRows.length > 0;
  }

  // ── Muat ulang dataset dari disk ───────────────────────────
  reload() {
    this.threshold = this.numConfig('CHAT_SIMILARITY_THRESHOLD', DEFAULT_THRESHOLD, 0, 1);
    this.answerMaxChars = this.numConfig('CHAT_ANSWER_MAX_CHARS', 1500, 200, 20000);
    this.debug = /^(1|true|yes)$/i.test(String(this.config.get<string>('CHAT_DEBUG') || '').trim());

    const qaFile = this.findQaFile();
    if (qaFile) {
      try {
        this.qaRows = this.loadQaFile(qaFile);
        this.qaPath = qaFile;
        this.primary = /\.csv$/i.test(qaFile) || /gabungan/i.test(qaFile) || this.qaRows.length >= 50;
        this.logger.log(
          `Dataset Legal QA dimuat: ${this.qaRows.length} baris dari ${qaFile}` +
            (this.primary ? ' (dataset gabungan aktif)' : ' (dataset contoh)'),
        );
      } catch (err) {
        this.logger.error(`Gagal memuat dataset Legal QA ${qaFile}: ${this.err(err)}`);
        this.qaRows = [];
        this.primary = false;
      }
    } else {
      this.qaRows = [];
      this.qaPath = '';
      this.primary = false;
      this.logger.warn(
        'Dataset Legal QA tidak ditemukan. Letakkan file CSV di folder data/ (lihat data/README.md).',
      );
    }

    const clsFile = this.findClassificationFile();
    if (clsFile) {
      try {
        this.classificationRows = this.loadClassificationFile(clsFile);
        this.classificationPath = clsFile;
        this.logger.log(`Dataset klasifikasi dimuat: ${this.classificationRows.length} baris dari ${clsFile}`);
      } catch (err) {
        this.logger.error(`Gagal memuat dataset klasifikasi ${clsFile}: ${this.err(err)}`);
        this.classificationRows = [];
      }
    } else {
      this.classificationRows = [];
      this.classificationPath = '';
      this.logger.warn('Dataset klasifikasi tidak ditemukan (opsional). Prediksi kategori dilewati.');
    }

    this.buildQaIndex();
    this.buildClassifier();

    const cats = new Set<string>();
    for (const r of this.qaRows) for (const c of r.categories) cats.add(c);
    this.categories = [...cats].sort();

    this.loadedAt = Date.now();
  }

  // -- Jawab dari dataset (retrieval dibobot + fallback klasifikasi) --
  answer(message: string): LegalQaResult {
    const pesan = String(message ?? '').trim();
    if (!pesan) return { reply: 'Silakan ceritakan masalah hukum yang ingin kamu konsultasikan.', intent: 'kosong', category: null, score: 0, link: null, question: null, hits: [] };
    const intent = this.detectIntent(pesan);
    if (intent === 'sapaan') return { reply: 'Halo! Selamat datang di layanan konsultasi hukum awal.\n\nKamu bisa menceritakan masalah hukum atau menanyakan informasi hukum yang ingin kamu ketahui.', intent, category: null, score: 0, link: null, question: null, hits: [] };
    if (intent === 'konsultasi') return { reply: 'Tentu, saya siap membantu kamu memulai konsultasi hukum.\n\nKamu bisa:\n1. Menceritakan masalah hukum yang sedang kamu hadapi.\n2. Meminta informasi mengenai advokat atau LBH.\n\nCeritakan kebutuhanmu terlebih dahulu.', intent, category: null, score: 0, link: null, question: null, hits: [] };
    if (intent === 'rekomendasi_advokat') return { reply: 'Saya bisa membantu mengarahkan pencarian bantuan hukum.\n\nSaat ini direktori advokat dan LBH belum terhubung ke sistem, sehingga saya belum bisa memberikan rekomendasi nama atau kontak yang terverifikasi.', intent, category: null, score: 0, link: null, question: null, hits: [] };
    if (!this.qaRows.length) return { reply: 'Dataset hukum lokal belum tersedia di server, jadi saya belum bisa menjawab pertanyaan ini. Silakan coba lagi nanti atau hubungi pengacara HukumIn.', intent, category: null, score: 0, link: null, question: null, hits: [] };

    const category = this.predictCategory(pesan);
    const hits = this.search(pesan, category);
    const best = hits[0];

    if (!best || best.score < this.threshold) {
      const cls = this.bestClassificationMatch(pesan);
      if (cls) {
        const alt = this.search(pesan + ' ' + cls.category, null).find((h) => h.row.categories.some((c) => c.toLowerCase().includes(cls.category.toLowerCase())));
        const steps = this.categorySteps(cls.category);
        const src = alt ? ('\n\nRujukan terkait (dataset Legal QA):\n' + alt.row.question + '\n' + this.trimAnswer(alt.row.answer, 700) + '\nSumber: ' + (alt.row.link || '-')) : '';
        return { reply: 'Kategori perkiraan (dari dataset klasifikasi): ' + cls.category + '\n\nLaporan/kasus serupa: ' + cls.text + '\n\n' + steps + src + '\n\nCatatan: Informasi umum dari dataset HukumIn, bukan nasihat hukum resmi.', intent, category: cls.category, score: alt?.score ?? 0.01, link: alt?.row.link ?? null, question: alt?.row.question ?? cls.text, hits: alt ? [alt] : hits };
      }
      const label = category ? ('Kategori sementara: ' + category + '\n\n') : '';
      return { reply: label + 'Saya belum menemukan penjelasan hukum yang cukup relevan di dataset untuk pertanyaan ini.\n\nAgar saya bisa membantu lebih tepat, ceritakan:\n1. Kronologi kejadian\n2. Waktu dan tempat\n3. Pihak yang terlibat\n4. Bukti/saksi yang ada', intent, category, score: best?.score ?? 0, link: null, question: null, hits };
    }

      const answer = this.trimAnswer(best.row.answer, this.answerMaxChars);
    const rowCategory = this.normalizeCategory(best.row.categories[0] ?? category ?? '-');
    const refQ = this.cleanRefText(best.row.question);
    const refTitle = this.cleanRefText(best.row.title);
    const refBlock = [refTitle, refQ].filter(Boolean).join('\n');
    const steps = this.categorySteps(rowCategory);
    const reply = [
      `Kategori: ${rowCategory}`,
      '',
      'Ringkasan jawaban:',
      this.cleanAnswer(answer, 900),
      '',
      'Langkah yang bisa dilakukan:',
      steps,
      '',
      'Referensi dataset:',
      refBlock || '-',
      best.row.link ? `Sumber: ${best.row.link}` : '',
      '',
      'Catatan: Jawaban diambil dari dataset HukumIn (543 QA + 500 klasifikasi) berdasarkan kemiripan kasus. Ini informasi umum, bukan nasihat hukum resmi.',
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n');
    return { reply, intent, category: rowCategory, score: best.score, link: best.row.link || null, question: best.row.question, hits };
  }

  private bestClassificationMatch(text: string): ClassificationRow | null {
    if (!this.classificationRows.length) return null;
    const q = new Set(this.queryTokens(this.normalize(text)));
    if (!q.size) return null;
    let best: { row: ClassificationRow; s: number } | null = null;
    for (const row of this.classificationRows) {
      const toks = this.tokenize(row.text);
      let s = 0;
      for (const t of toks) if (q.has(t)) s += t.length >= 5 ? 2 : 1;
      if (!best || s > best.s) best = { row, s };
    }
    return best && best.s >= 2 ? best.row : null;
  }

  private categorySteps(category: string): string {
    const c = (category || '').toLowerCase();
    if (c.includes('penganiayaan')) return 'Langkah umum (pidana penganiayaan): 1) Utamakan keselamatan & berobat/visum jika ada luka. 2) Kumpulkan bukti (foto luka, kronologi, identitas saksi/pelaku, CCTV). 3) Lapor ke kepolisian (SPKT) dengan bukti. 4) Konsultasi advokat/posbakum untuk pendampingan.';
    if (c.includes('penipuan') || c.includes('penggelapan')) return 'Langkah umum (penipuan/penggelapan): 1) Kumpulkan bukti (chat, bukti transfer, invoice/rekam jejak, identitas/akun pelaku, kronologi). 2) Lapor ke kepolisian/cyber crime bila elektronik. 3) Hubungi bank/platform untuk pembekuan/penelusuran sesuai ketentuan. 4) Konsultasi advokat bila kerugian besar.';
    if (c.includes('pencurian')) return 'Langkah umum (pencurian): 1) Amankan lokasi & bukti (CCTV, saksi, daftar barang, STNK/bukti kepemilikan). 2) Segera lapor polisi dengan identitas dan kronologi. 3) Simpan bukti kepemilikan bila ada. 4) Konsultasi advokat bila diperlukan.';
    if (c.includes('pencemaran')) return 'Langkah umum (pencemaran nama baik/fitnah): 1) Simpan bukti (tangkapan layar, tautan, waktu, akun). 2) Hindari menyebarluaskan balik. 3) Pertimbangkan somasi/laporan sesuai UU ITE/KUHP dengan bantuan advokat. 4) Konsultasi advokat untuk menilai unsur pidana/perdata.';
    if (c.includes('pelecehan') || c.includes('seksual')) return 'Langkah umum (pelecehan/kekerasan seksual): 1) Utamakan keselamatan diri; cari dukungan tepercaya. 2) Simpan bukti (chat/pesan, saksi, rekaman sesuai hukum, kronologi). 3) Bila ada cedera/kejadian baru, pertimbangkan visum/pertolongan medis. 4) Lapor ke kepolisian/UPPA atau layanan pengaduan yang relevan; konsultasi advokat/pendamping hukum. (Konteks UU TPKS/KUHP dapat relevan tergantung fakta.)';
    return 'Langkah umum: 1) Tulis kronologi jelas (waktu, tempat, pihak). 2) Kumpulkan bukti/saksi. 3) Lapor pihak berwenang bila ada dugaan pidana. 4) Konsultasi advokat HukumIn untuk langkah tepat.';
  }

  private normalizeCategory(raw: string): string {
    const t = (raw || '').trim().toLowerCase();
    if (!t) return '-';
    if (t.includes('tipu') || t.includes('gelap') || t.includes('penipuan') || t.includes('penggelapan')) return 'Penipuan dan Penggelapan';
    if (t.includes('curi') || t.includes('pencurian')) return 'Pencurian';
    if (t.includes('aniaya') || t.includes('penganiayaan') || t.includes('kekerasan fisik')) return 'Penganiayaan';
    if (t.includes('cema') || t.includes('fitnah') || t.includes('pencemaran')) return 'Pencemaran Nama Baik';
    if (t.includes('seksual') || t.includes('pelecehan') || t.includes('tpks')) return 'Pelecehan/Kekerasan Seksual';
    return raw.trim().replace(/\s+/g, ' ');
  }

  private cleanRefText(v: string): string {
    return (v || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  private cleanAnswer(v: string, max: number): string {
    let t = (v || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    t = t
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/_{1,2}([^_\n]+)_{1,2}/g, '$1')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return this.trimAnswer(t, max);
  }

  /** Konteks ringkas untuk AI eksternal (3 hit teratas). */
  buildContext(message: string): string {
    if (!this.qaRows.length) return '';
    const hits = this.search(message, this.predictCategory(message)).slice(0, 3);
    if (!hits.length) return '';
    const lines = hits.map((h, i) => {
      const head = (h.row.title || h.row.question).trim();
      const body = this.trimAnswer(h.row.answer, 900);
      return `${i + 1}. [${h.row.categories[0] ?? 'Umum'}] ${head}\nPertanyaan: ${h.row.question}\nJawaban rujukan: ${body}${h.row.link ? `\nSumber: ${h.row.link}` : ''}`;
    });
    return `Konteks dataset lokal HukumIn (gunakan sebagai rujukan utama; jawab sesuai data ini; jangan mengarang fakta/pasal baru):\n${lines.join('\n\n')}`;
  }

  // ── Deteksi intent (port deteksi_intent) ──────────────────
  private detectIntent(pesan: string): LegalIntent {
    const text = pesan.toLowerCase().trim();
    const kataSapaan = [
      'hai', 'halo', 'hello', 'hi',
      'selamat pagi', 'selamat siang',
      'selamat sore', 'selamat malam',
    ];
    const kataKonsultasi = [
      'saya mau konsultasi',
      'aku mau konsultasi',
      'ingin konsultasi',
      'mau konsultasi',
      'bisa konsultasi',
      'saya ingin bertanya',
    ];
    const kataAdvokat = [
      'advokat', 'pengacara',
      'bantuan hukum',
      'lembaga bantuan hukum',
      'lbh', 'cari pengacara',
    ];

    for (const kata of kataSapaan) {
      if (new RegExp(`(?<!\\w)${this.escapeRe(kata)}(?!\\w)`, 'u').test(text)) return 'sapaan';
    }
    if (kataKonsultasi.some((k) => text.includes(k))) return 'konsultasi';
    if (kataAdvokat.some((k) => text.includes(k))) return 'rekomendasi_advokat';
    return 'laporan';
  }

  // ── Klasifikasi kategori (port model LinearSVC) ───────────
  private predictCategory(text: string): string | null {
    if (!this.classificationRows.length || !this.clsWeights.length) return null;
    const vector = this.transform(text, this.clsIdf);
    if (!vector.size) return null;
    const scores = this.clsWeights.map((w) => {
      let s = 0;
      for (const [term, value] of vector) {
        const idx = this.termIndex.get(term);
        if (idx !== undefined) s += value * w[idx];
      }
      return s;
    });
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    return this.clsLabels[best] ?? null;
  }

  // ── Pencarian kemiripan (TF-IDF + lexical/phrase boost, fallback global) ──
  private search(text: string, predictedCategory: string | null): DatasetHit[] {
    const queryNorm = this.normalize(text);
    const queryTokens = this.queryTokens(queryNorm);
    if (!queryTokens.length) return this.qaRows.slice(0, 5).map((row) => ({ row, score: 0 }));

    const queryVec = this.transform(text, this.qaIdf);
    const scored: Array<{ row: QaRow; score: number; base: number }> = [];

    for (let i = 0; i < this.qaRows.length; i++) {
      const row = this.qaRows[i];
      let base = 0;
      const vec = this.qaVectors[i];
      for (const [term, value] of queryVec) {
        const other = vec.get(term);
        if (other !== undefined) base += value * other;
      }

      // Lexical boosts: prioritaskan Title/Question (tempat pertanyaan user paling cocok).
      let boost = 0;
      if (row.normQuestion && (queryNorm.includes(row.normQuestion) || row.normQuestion.includes(queryNorm))) boost += 2.2;
      if (row.normTitle && (queryNorm.includes(row.normTitle) || row.normTitle.includes(queryNorm))) boost += 1.6;

      let qHits = 0;
      let tHits = 0;
      let uniq = 0;
      for (const tok of queryTokens) {
        const hitQ = row.normQuestion.includes(tok);
        const hitT = row.normTitle.includes(tok);
        const hitA = row.normAnswer.includes(tok) || row.tokenSet.has(tok);
        if (hitQ) qHits++;
        if (hitT) tHits++;
        if (hitQ || hitT || hitA) {
          uniq++;
          boost += tok.length >= 5 ? 0.05 : 0.022;
          if (hitQ) boost += 0.09;
          if (hitT) boost += 0.06;
          if (!hitQ && !hitT && hitA) boost += 0.01;
        }
      }
      const coverage = uniq / Math.max(1, queryTokens.length);
      boost += coverage * 0.75;
      if (qHits >= Math.min(3, queryTokens.length) && queryTokens.length >= 2) boost += 0.5;
      if (tHits >= Math.min(3, queryTokens.length) && queryTokens.length >= 2) boost += 0.32;
      if (qHits === 0 && tHits === 0 && base < 0.08) boost -= 0.18;

      // Intent-aware topical boosts (lebih spesifik ke maksud pertanyaan umum user).
      const has = (re: RegExp) => re.test(queryNorm);
      const rowHas = (re: RegExp) => re.test(row.normTitle) || re.test(row.normQuestion);
      const rowHasAll = (re: RegExp) => re.test(row.normTitle) || re.test(row.normQuestion) || re.test(row.normAnswer);
      if (has(/marketplace|transfer|tertipu|penipuan/) && (has(/online|marketplace|transfer/) || rowHas(/penipuan.*online|jual beli.*online|pasal penipuan online|tertipu/))) {
        if (rowHas(/pasal penipuan.*online|menjerat pelaku/)) boost += 0.95;
        if (rowHas(/panduan.*melaporkan penipuan.*online|melaporkan penipuan.*online/)) boost += 0.9;
        if (rowHas(/penipuan.*online|jual beli.*online|cara penyidik.*penipuan|tertipu/)) boost += 0.85;
        if (rowHas(/vcs|kencan online|mobil.*luar negeri/) && !has(/vcs|kencan|mobil|luar negeri/)) boost -= 0.5;
      }
      if (has(/titipan|tidak dikembalikan|dipinjam tidak dikembalikan/) || (has(/pinjam/) && has(/tidak.*kembali|tidak.*dikembalikan/))) {
        if (rowHas(/pinjam pakai.*penggelapan|pelanggaran perjanjian pinjam pakai|penggelapan/)) boost += 1.15;
        if (rowHas(/barang titipan|dititipkan wajib mengganti|penerima titipan/)) boost += 0.95;
        if (rowHas(/barang curian dikembalikan/) && !has(/curian/)) boost -= 0.55;
      }
      if (has(/motor|kendaraan bermotor/) && has(/curi|dicuri|pencurian/)) {
        if (rowHas(/motor|kendaraan bermotor|pencurian.*motor|sepeda motor/)) boost += 1.05;
        if (has(/tetangga/) && rowHas(/air pam|air dicuri/) && !rowHas(/motor|kendaraan/)) boost -= 0.8;
      }
      if (has(/pelecehan seksual|tindak pidana seksual|kekerasan seksual/)) {
        if (rowHas(/pelecehan seksual|tindak pidana kekerasan seksual|kekerasan seksual|uu tpks/)) boost += 1.15;
        if (rowHasAll(/pelecehan seksual|kekerasan seksual/) && !rowHas(/pelecehan seksual|kekerasan seksual/)) boost += 0.25;
        if (has(/kerja|tempat kerja/) && rowHasAll(/kerja|tempat kerja|perusahaan|karyawan|atasan|kantor/)) boost += 0.5;
        if (has(/kerja|tempat kerja/) && rowHas(/kereta api/) && !rowHasAll(/kerja|tempat kerja/)) boost -= 0.35;
        if (has(/kerja|tempat kerja/) && rowHas(/spill.*identitas|medsos/) && !rowHasAll(/kerja|tempat kerja/)) boost -= 0.25;
      }

      // Bonus kategori prediksi (soft, bukan hard filter) + penalti mismatch halus.
      if (predictedCategory) {
        const matchCat = row.categories.some((c) => c.trim().toLowerCase() === predictedCategory.trim().toLowerCase() || c.toLowerCase().includes(predictedCategory.toLowerCase()));
        boost += matchCat ? 0.07 : -0.03;
      }

      const score = base + boost;
      if (score > 0.015 || uniq > 0) scored.push({ row, score, base });
    }

    scored.sort((a, b) => b.score - a.score || b.base - a.base);
    const top = scored.slice(0, 8);
    if (this.debug && top[0]) {
      this.logger.debug(`QA hit: [${top[0].row.categories[0] ?? '-'}] score=${top[0].score.toFixed(3)} base=${top[0].base.toFixed(3)} q="${top[0].row.question.slice(0, 90)}"`);
    }
    return top.map(({ row, score }) => ({ row, score }));
  }

  // ── TF-IDF (dibobot: title x4, question x4, answer x1) ──
  private buildQaIndex() {
    this.qaIdf = new Map();
    this.qaVectors = [];
    if (!this.qaRows.length) return;

    const docs = this.qaRows.map((r) => this.weightedQaTokens(r));
    const df = new Map<string, number>();
    for (const tokens of docs) {
      for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const n = docs.length;
    for (const [term, count] of df) {
      this.qaIdf.set(term, Math.log((1 + n) / (1 + count)) + 1);
    }
    this.qaVectors = docs.map((tokens) => this.vectorize(tokens, this.qaIdf));
  }

  private weightedQaTokens(r: QaRow): string[] {
    const tq = this.tokenize(r.title);
    const qq = this.tokenize(r.question);
    const aq = this.tokenize(r.answer).slice(0, 1200); // batasi answer panjang agar title/question dominan
    return [...tq, ...tq, ...tq, ...tq, ...qq, ...qq, ...qq, ...qq, ...aq];
  }

  private buildClassifier() {
    this.clsIdf = new Map();
    this.clsWeights = [];
    this.clsLabels = [];
    this.termIndex = new Map();
    if (!this.classificationRows.length) return;

    const docs = this.classificationRows.map((r) => this.tokenize(r.text));
    const df = new Map<string, number>();
    for (const tokens of docs) {
      for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const n = docs.length;
    const idf = new Map<string, number>();
    for (const [term, count] of df) idf.set(term, Math.log((1 + n) / (1 + count)) + 1);

    const terms = [...idf.keys()];
    terms.forEach((t, i) => this.termIndex.set(t, i));
    const labels = [...new Set(this.classificationRows.map((r) => r.category))];
    const labelIndex = new Map(labels.map((l, i) => [l, i]));

    const X = docs.map((tokens) => this.vectorize(tokens, idf));
    const y = this.classificationRows.map((r) => labelIndex.get(r.category) ?? 0);

    // Multinomial logistic regression (batch gradient descent, deterministik).
    const k = labels.length;
    const d = terms.length;
    const W = Array.from({ length: k }, () => new Float64Array(d));
    const b = new Float64Array(k);
    const lr = 0.5;
    const epochs = 300;
    const l2 = 1e-5;

    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradW = Array.from({ length: k }, () => new Float64Array(d));
      const gradB = new Float64Array(k);
      for (let i = 0; i < X.length; i++) {
        const scores = new Float64Array(k);
        for (let c = 0; c < k; c++) {
          let s = b[c];
          const row = W[c];
          for (const [term, value] of X[i]) s += value * row[this.termIndex.get(term)!];
          scores[c] = s;
        }
        let max = -Infinity;
        for (let c = 0; c < k; c++) if (scores[c] > max) max = scores[c];
        let denom = 0;
        for (let c = 0; c < k; c++) denom += Math.exp(scores[c] - max);
        for (let c = 0; c < k; c++) {
          const p = Math.exp(scores[c] - max) / denom;
          const err = p - (y[i] === c ? 1 : 0);
          if (err === 0) continue;
          gradB[c] += err;
          const row = gradW[c];
          for (const [term, value] of X[i]) row[this.termIndex.get(term)!] += err * value;
        }
      }
      const m = X.length;
      for (let c = 0; c < k; c++) {
        for (let t = 0; t < d; t++) {
          W[c][t] -= lr * (gradW[c][t] / m + l2 * W[c][t]);
        }
        b[c] -= lr * (gradB[c] / m);
      }
    }

    this.clsWeights = W.map((row) => Array.from(row));
    this.clsLabels = labels;
  }

  /** Tokenisasi: token_pattern sklearn \b\w\w+\b + ngram (1,2). */
  private tokenize(text: string): string[] {
    const raw = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    const words = raw.filter((w) => w.length > 1);
    const grams: string[] = [];
    for (let i = 0; i < words.length; i++) {
      grams.push(words[i]);
      if (i + 1 < words.length) grams.push(`${words[i]} ${words[i + 1]}`);
    }
    return grams;
  }

  private normalize(text: string): string {
    return this.tokenize(text)
      .filter((t) => !t.includes(' '))
      .join(' ');
  }

  private queryTokens(norm: string): string[] {
    const stop = new Set(['yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada', 'atau', 'itu', 'ini', 'saya', 'aku', 'kami', 'kita', 'apa', 'apakah', 'bagaimana', 'bisa', 'dapat', 'bolehkah', 'jika', 'bila', 'karena', 'oleh', 'ada', 'tidak', 'tak', 'sudah', 'belum', 'akan', 'harus', 'kasus', 'hukum', 'langkah', 'termasuk', 'tentang', 'secara', 'waktu', 'saat', 'sampai', 'terus', 'hingga', 'lalu', 'kemudian', 'sebuah', 'suatu', 'orang', 'dilakukan', 'melakukan']);
    const base = norm.split(/\s+/).filter((t) => t.length > 1 && !stop.has(t));
    const expanded = new Set(base);
    const raw = norm;
    const add = (...xs: string[]) => xs.forEach((x) => expanded.add(x));
    if (/marketplace|tokopedia|shopee|bukalapak|olshop|online shop|toko online|jual beli online|e commerce|ecommerce/.test(raw)) add('penipuan', 'online', 'transaksi', 'korban', 'lapor', 'marketplace', 'pidana', 'pasal', 'menjerat', 'jual', 'beli');
    if (/transfer|rekening|dana|ovo|gopay|pembayaran|bayar/.test(raw)) add('transfer', 'uang', 'penipuan', 'lapor', 'online');
    if (/tertipu|ditipu|penipuan|scam|modus/.test(raw)) add('penipuan', 'tertipu', 'lapor', 'pidana', 'online');
    if (/didorong|dipukul|ditampar|dianiaya|dikeroyok|ditendang|memukul|penganiayaan|luka|pukul|tendang|aniaya/.test(raw)) add('penganiayaan', 'pidana', 'lapor', 'visum', 'kekerasan', 'memukul');
    if (/bertengkar|ribut|tetangga/.test(raw)) add('penganiayaan', 'lapor', 'tetangga');
    if (/titipan|tidak dikembalikan|barang tidak kembali|pinjam tidak kembali|dipinjam tidak dikembalikan|barang titipan/.test(raw)) add('penggelapan', 'titipan', 'barang', 'pidana', 'lapor', 'mengganti', 'dikembalikan', 'pinjam');
    if (/digelapkan|penggelapan/.test(raw)) add('penggelapan', 'pidana', 'lapor', 'barang');
    if (/dicuri|pencurian|\bcuri\b|maling|hilang dicuri|kemalingan/.test(raw)) add('pencurian', 'curi', 'lapor', 'pidana', 'barang', 'bukti');
    if (/motor|kendaraan bermotor|sepeda motor|mobil/.test(raw)) add('motor', 'pencurian', 'kendaraan', 'bermotor', 'curi');
    if (/fitnah|difitnah|pencemaran|nama baik|hinaan|hujat|menyebarkan|medsos|media sosial/.test(raw)) add('pencemaran', 'nama', 'baik', 'fitnah', 'lapor', 'uu', 'ite', 'media', 'sosial');
    if (/pelecehan|seksual|tpk?s|kekerasan seksual/.test(raw)) add('pelecehan', 'seksual', 'lapor', 'pidana', 'tindak', 'kekerasan', 'kerja');
    if (/kdrt|kekerasan dalam rumah tangga/.test(raw)) add('kdrt', 'kekerasan', 'rumah', 'tangga', 'lapor');
    if (/wanprestasi|utang piutang|perjanjian|kontrak/.test(raw)) add('wanprestasi', 'perdata', 'perjanjian');
    if (/ancaman|mengancam|diperas|pemerasan/.test(raw)) add('ancaman', 'pidana', 'lapor');
    return [...expanded].filter((t) => t.length > 1).slice(0, 36);
  }

  /** TF-IDF sublinear (1 + ln tf) * idf, lalu L2 normalisasi. */
  private vectorize(tokens: string[], idf: Map<string, number>): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of tf) {
      const idfValue = idf.get(term);
      if (idfValue === undefined) continue;
      const value = (1 + Math.log(count)) * idfValue;
      vec.set(term, value);
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (const [term, value] of vec) vec.set(term, value / norm);
    }
    return vec;
  }

  private transform(text: string, idf: Map<string, number>): Map<string, number> {
    return this.vectorize(this.tokenize(text), idf);
  }

  // ── Pemuatan file ─────────────────────────────────────────
  private findQaFile(): string | null {
    const configured = (this.config.get<string>('CHAT_QA_DATASET_PATH') || '').trim();
    if (configured) {
      const p = this.resolvePath(configured);
      if (existsSync(p)) return p;
      this.logger.warn(`CHAT_QA_DATASET_PATH tidak ditemukan: ${p}. Melanjutkan pencarian otomatis di folder data/.`);
    }
    const files = this.scanDataDir();
    // CSV (dataset gabungan) selalu didahulukan daripada JSON contoh kecil.
    const csvFiles = files.filter((p) => /\.csv$/i.test(p));
    const jsonFiles = files.filter((p) => /\.json$/i.test(p));

    for (const p of csvFiles) {
      try {
        const rows = this.parseCsv(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
        if (!rows.length) continue;
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const hasQuestion = header.some((h) => h === 'question' || h === 'pertanyaan' || h === 'q');
        const hasAnswer = header.some((h) => h === 'answer' || h === 'jawaban' || h === 'a');
        if (hasQuestion && hasAnswer) return p;
      } catch {
        /* abaikan file csv yang tidak valid */
      }
    }

    // JSON gabungan besar (gabungan-dataset.json / >50 entri) didahulukan daripada dataset contoh.
    let fallback: string | null = null;
    for (const p of jsonFiles) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
        const arr = Array.isArray(raw) ? raw : (raw as any)?.items ?? (raw as any)?.data;
        if (!Array.isArray(arr) || !arr.some((x: any) => x && (x.question ?? x.Question ?? x.answer ?? x.Answer))) continue;
        const name = p.toLowerCase();
        const primary = name.includes('gabungan') || arr.length >= 50 || String((raw as any)?.meta?.source ?? '').includes('gabungan');
        if (primary) return p;
        if (!fallback) fallback = p;
      } catch {
        /* abaikan file json yang tidak valid */
      }
    }
    return fallback;
  }

  private findClassificationFile(): string | null {
    const configured = (this.config.get<string>('CHAT_CLASSIFICATION_DATASET_PATH') || '').trim();
    if (configured) {
      const p = this.resolvePath(configured);
      if (existsSync(p)) return p;
      this.logger.warn(`CHAT_CLASSIFICATION_DATASET_PATH tidak ditemukan: ${p}. Melanjutkan pencarian otomatis di folder data/.`);
    }
    for (const p of this.scanDataDir()) {
      if (!/\.csv$/i.test(p)) continue;
      if (p === this.qaPath) continue;
      try {
        const rows = this.parseCsv(readFileSync(p, 'utf8').replace(/^﻿/, ''));
        if (!rows.length) continue;
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const hasText = header.some((h) => ['teks_laporan', 'text', 'laporan', 'teks'].includes(h));
        const hasLabel = header.some((h) => ['kategori', 'category', 'label'].includes(h));
        if (hasText && hasLabel) return p;
      } catch {
        /* abaikan file csv yang tidak valid */
      }
    }
    return null;
  }

  private scanDataDir(): string[] {
    const dir = resolve(process.cwd(), 'data');
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => /\.(csv|json|jsonl)$/i.test(f))
        .map((f) => join(dir, f))
        .filter((p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      return [];
    }
  }

  private loadQaFile(file: string): QaRow[] {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (/\.json$/i.test(file)) {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed as any)?.items ?? (parsed as any)?.data ?? [];
      return arr
        .map((x: any, i: number): QaRow | null => {
          if (!x || typeof x !== 'object') return null;
          const question = this.clean(x.question ?? x.Question ?? x.pertanyaan ?? x.prompt ?? '');
          const answer = this.clean(x.answer ?? x.Answer ?? x.jawaban ?? '');
          if (!question && !answer) return null;
          const categories = this.splitCategories(x.kategori ?? x.category ?? x.kategori_set ?? '');
          const title = this.clean(x.title ?? x.Title ?? '');
          const link = this.clean(x.link ?? x.Link ?? x.source ?? '');
          return this.makeRow(String(x.id ?? `qa-${i + 1}`), title, link, question || answer.slice(0, 120), answer || question, categories);
        })
        .filter((x: QaRow | null): x is QaRow => !!x);
    }

    const rows = this.parseCsv(raw);
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => this.clean(h).toLowerCase());
    const idx = (...names: string[]) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const iTitle = idx('title');
    const iLink = idx('link', 'url', 'sumber');
    const iQuestion = idx('question', 'pertanyaan', 'q');
    const iAnswer = idx('answer', 'jawaban', 'a', 'penjelasan');
    const iCategory = idx('kategori', 'category', 'kategori_set', 'topik');
    if (iQuestion < 0 || iAnswer < 0) return [];

    const out: QaRow[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const question = this.clean(row[iQuestion] ?? '');
      const answer = this.clean(row[iAnswer] ?? '');
      if (!question && !answer) continue;
      const title = iTitle >= 0 ? this.clean(row[iTitle] ?? '') : '';
      const link = iLink >= 0 ? this.clean(row[iLink] ?? '') : '';
      const categories = iCategory >= 0 ? this.splitCategories(row[iCategory] ?? '') : [];
      out.push(this.makeRow(`qa-${r}`, title, link, question || answer.slice(0, 120), answer || question, categories));
    }
    return out;
  }

  private makeRow(id: string, title: string, link: string, question: string, answer: string, categories: string[]): QaRow {
    const normTitle = this.normalize(title);
    const normQuestion = this.normalize(question);
    const normAnswer = this.normalize(answer).slice(0, 6000);
    const normAll = `${normTitle} ${normQuestion} ${normAnswer}`.trim();
    return {
      id,
      title,
      link,
      question,
      answer,
      categories,
      searchText: `${title} ${question} ${answer}`,
      normTitle,
      normQuestion,
      normAnswer,
      normAll,
      tokenSet: new Set(normAll.split(/\s+/).filter((t) => t.length > 1)),
    };
  }

  private loadClassificationFile(file: string): ClassificationRow[] {
    const rows = this.parseCsv(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => this.clean(h).toLowerCase());
    const iText = header.findIndex((h) => ['teks_laporan', 'text', 'laporan', 'teks'].includes(h));
    const iCat = header.findIndex((h) => ['kategori', 'category', 'label'].includes(h));
    if (iText < 0 || iCat < 0) return [];
    const out: ClassificationRow[] = [];
    for (let r = 1; r < rows.length; r++) {
      const text = this.clean(rows[r][iText] ?? '');
      const category = this.clean(rows[r][iCat] ?? '');
      if (!text || !category) continue;
      out.push({ text, category });
    }
    return out;
  }

  // ── Utilitas ──────────────────────────────────────────────
  private splitCategories(value: unknown): string[] {
    const raw = Array.isArray(value) ? value.join(';') : String(value ?? '');
    return raw
      .split(';')
      .map((v) => this.clean(v))
      .filter(Boolean);
  }

  /** Parser CSV aman untuk teks panjang berisi koma, kutip, dan newline. */
  private parseCsv(raw: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inQuotes) {
        if (c === '"') {
          if (raw[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => this.clean(v).length > 0));
  }

  private trimAnswer(text: string, max = this.answerMaxChars): string {
    const value = String(text ?? '').trim();
    if (value.length <= max) return value;
    const cut = value.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}… (ringkasan, sumber lengkap ada di tautan di bawah)`;
  }

  private numConfig(name: string, fallback: number, min: number, max: number): number {
    const raw = Number(this.config.get<string>(name) ?? fallback);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, raw));
  }

  private resolvePath(p: string) {
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }

  private clean(v: unknown) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  private escapeRe(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private err(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}
