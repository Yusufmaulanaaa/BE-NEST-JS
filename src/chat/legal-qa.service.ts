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
 * File CSV asli dibaca otomatis dari folder `data/` (lihat data/README.md).
 */

export interface QaRow {
  title: string;
  link: string;
  question: string;
  answer: string;
  /** kategori bisa berisi lebih dari satu label, dipisah tanda titik koma ";" */
  categories: string[];
  searchText: string;
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

  // Indeks TF-IDF untuk pencarian kemiripan.
  private qaIdf = new Map<string, number>();
  private qaVectors: Array<Map<string, number>> = [];
  // Indeks TF-IDF + bobot klasifikasi.
  private clsIdf = new Map<string, number>();
  private clsWeights: number[][] = [];
  private clsLabels: string[] = [];
  private termIndex = new Map<string, number>();

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

  // ── Inti: port fungsi chatbot() dari notebook ─────────────
  answer(message: string): LegalQaResult {
    const pesan = String(message ?? '').trim();
    if (!pesan) {
      return {
        reply: 'Silakan ceritakan masalah hukum yang ingin kamu konsultasikan.',
        intent: 'kosong',
        category: null,
        score: 0,
        link: null,
        question: null,
        hits: [],
      };
    }

    const intent = this.detectIntent(pesan);
    if (intent === 'sapaan') {
      return {
        reply:
          'Halo! Selamat datang di layanan konsultasi hukum awal.\n\n' +
          'Kamu bisa menceritakan masalah hukum atau menanyakan informasi hukum yang ingin kamu ketahui.',
        intent,
        category: null,
        score: 0,
        link: null,
        question: null,
        hits: [],
      };
    }
    if (intent === 'konsultasi') {
      return {
        reply:
          'Tentu, saya siap membantu kamu memulai konsultasi hukum.\n\n' +
          'Kamu bisa:\n' +
          '1. Menceritakan masalah hukum yang sedang kamu hadapi.\n' +
          '2. Meminta informasi mengenai advokat atau LBH.\n\n' +
          'Ceritakan kebutuhanmu terlebih dahulu.',
        intent,
        category: null,
        score: 0,
        link: null,
        question: null,
        hits: [],
      };
    }
    if (intent === 'rekomendasi_advokat') {
      return {
        reply:
          'Saya bisa membantu mengarahkan pencarian bantuan hukum.\n\n' +
          'Saat ini direktori advokat dan LBH belum terhubung ke sistem, sehingga saya belum bisa memberikan ' +
          'rekomendasi nama atau kontak yang terverifikasi.',
        intent,
        category: null,
        score: 0,
        link: null,
        question: null,
        hits: [],
      };
    }

    if (!this.qaRows.length) {
      return {
        reply:
          'Dataset hukum lokal belum tersedia di server, jadi saya belum bisa menjawab pertanyaan ini. ' +
          'Silakan coba lagi nanti atau hubungi pengacara HukumIn.',
        intent,
        category: null,
        score: 0,
        link: null,
        question: null,
        hits: [],
      };
    }

    const category = this.predictCategory(pesan);
    const hits = this.search(pesan, category);
    const best = hits[0];

    if (!best || best.score < this.threshold) {
      const label = category ? `Kategori sementara: ${category}\n\n` : '';
      return {
        reply:
          `${label}Saya belum menemukan penjelasan hukum yang cukup relevan dengan cerita kamu.\n\n` +
          'Agar saya bisa membantu lebih tepat, ceritakan:\n' +
          '1. Bagaimana kronologi kejadian?\n' +
          '2. Kapan dan di mana kejadian berlangsung?\n' +
          '3. Siapa saja yang terlibat?\n' +
          '4. Apakah terdapat saksi atau bukti?',
        intent,
        category,
        score: best?.score ?? 0,
        link: null,
        question: null,
        hits,
      };
    }

    const answer = this.trimAnswer(best.row.answer, this.answerMaxChars);
    const reply =
      `Kategori hasil klasifikasi: ${category ?? best.row.categories[0] ?? '-'}\n\n` +
      `Pertanyaan terkait:\n${best.row.question}\n\n` +
      `Penjelasan hukum:\n${answer}\n\n` +
      `Sumber: ${best.row.link || '-'}\n` +
      `Skor kemiripan: ${best.score.toFixed(3)}\n\n` +
      'Catatan: Jawaban ini diambil dari dataset Legal QA berdasarkan kemiripan teks. ' +
      'Informasi ini merupakan konsultasi awal dan bukan pengganti nasihat advokat.';

    return {
      reply,
      intent,
      category,
      score: best.score,
      link: best.row.link || null,
      question: best.row.question,
      hits,
    };
  }

  /** Konteks ringkas untuk AI eksternal (3 hit teratas). */
  buildContext(message: string): string {
    if (!this.qaRows.length) return '';
    const hits = this.search(message, this.predictCategory(message)).slice(0, 3);
    if (!hits.length) return '';
    const lines = hits.map((h, i) => {
      const head = (h.row.title || h.row.question).trim();
      const body = this.trimAnswer(h.row.answer, 900);
      return `${i + 1}. ${head}\nJawaban rujukan: ${body}${h.row.link ? `\nSumber: ${h.row.link}` : ''}`;
    });
    return `Konteks dataset lokal HukumIn (gunakan sebagai rujukan utama; jangan mengarang fakta baru):\n${lines.join('\n\n')}`;
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

  // ── Pencarian kemiripan (port cosine_similarity) ──────────
  private search(text: string, category: string | null): DatasetHit[] {
    const query = this.transform(text, this.qaIdf);
    const scored: DatasetHit[] = [];
    for (let i = 0; i < this.qaRows.length; i++) {
      const row = this.qaRows[i];
      if (
        category &&
        !row.categories.some((c) => c.trim().toLowerCase() === category.trim().toLowerCase())
      ) {
        continue;
      }
      let score = 0;
      const vec = this.qaVectors[i];
      for (const [term, value] of query) {
        const other = vec.get(term);
        if (other !== undefined) score += value * other;
      }
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  // ── TF-IDF (port TfidfVectorizer lowercase, ngram (1,2), sublinear_tf) ──
  private buildQaIndex() {
    this.qaIdf = new Map();
    this.qaVectors = [];
    if (!this.qaRows.length) return;

    const docs = this.qaRows.map((r) => this.tokenize(r.searchText));
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
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (/\.json$/i.test(file)) {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed as any)?.items ?? (parsed as any)?.data ?? [];
      return arr
        .map((x: any): QaRow | null => {
          if (!x || typeof x !== 'object') return null;
          const question = this.clean(x.question ?? x.Question ?? x.pertanyaan ?? x.prompt ?? '');
          const answer = this.clean(x.answer ?? x.Answer ?? x.jawaban ?? '');
          if (!question && !answer) return null;
          const categories = this.splitCategories(x.kategori ?? x.category ?? x.kategori_set ?? '');
          const title = this.clean(x.title ?? x.Title ?? '');
          const link = this.clean(x.link ?? x.Link ?? x.source ?? '');
          return {
            title,
            link,
            question: question || answer.slice(0, 120),
            answer: answer || question,
            categories,
            searchText: `${title} ${question} ${answer}`,
          };
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
      out.push({
        title,
        link,
        question: question || answer.slice(0, 120),
        answer: answer || question,
        categories,
        searchText: `${title} ${question} ${answer}`,
      });
    }
    return out;
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
