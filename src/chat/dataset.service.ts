import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';

export interface DatasetEntry {
  id: string;
  keywords: string[];
  question: string;
  answer: string;
  category?: string;
  source?: string;
}

@Injectable()
export class DatasetService implements OnModuleInit {
  private readonly logger = new Logger(DatasetService.name);
  private entries: DatasetEntry[] = [];
  private loadedPath = '';
  private loadedAt = 0;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.reload();
  }

  getStatus() {
    return { loaded: this.entries.length, path: this.loadedPath || null, loadedAt: this.loadedAt || null };
  }

  reload() {
    const configured = (this.config.get<string>('CHAT_DATASET_PATH') || '').trim();
    const candidates = configured
      ? [this.resolvePath(configured)]
      : [
          resolve(process.cwd(), 'data/gabungan-dataset.json'),
          resolve(process.cwd(), 'data/gabungan_dataset.json'),
          resolve(process.cwd(), 'data/gabungan-dataset.jsonl'),
          resolve(process.cwd(), 'data/gabungan-dataset.csv'),
          resolve(process.cwd(), 'data/chatbot-dataset.json'),
          resolve(process.cwd(), 'data/dataset.json'),
          resolve(process.cwd(), 'data/chatbot-dataset.jsonl'),
          resolve(process.cwd(), 'data/chatbot-dataset.csv'),
          resolve(process.cwd(), 'gabungan-dataset.json'),
          resolve(process.cwd(), 'gabungan_dataset.json'),
          resolve(process.cwd(), 'gabungan-dataset.csv'),
          resolve(process.cwd(), 'src/chat/dataset/chatbot-dataset.json'),
          resolve(__dirname, '../../data/gabungan-dataset.json'),
          resolve(__dirname, '../../data/chatbot-dataset.json'),
          resolve(__dirname, '../../../data/gabungan-dataset.json'),
          resolve(__dirname, '../../../data/chatbot-dataset.json'),
        ];

    for (const file of candidates) {
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const parsed = this.parse(raw, file);
        this.entries = parsed;
        this.loadedPath = file;
        this.loadedAt = Date.now();
        this.logger.log(`Chat dataset loaded: ${this.entries.length} entries from ${file}`);
        return;
      } catch (err) {
        this.logger.warn(`Failed to load dataset ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.entries = [];
    this.loadedPath = '';
    this.loadedAt = 0;
    this.logger.log('No chatbot dataset file found; running with prompt-only/mock fallback.');
  }

  retrieve(query: string, limit = 4): DatasetEntry[] {
    if (!this.entries.length) return [];
    const q = this.normalize(query);
    const qTokens = this.tokens(q);
    if (!qTokens.length) return this.entries.slice(0, limit);

    const scored = this.entries
      .map((e) => ({ e, score: this.score(q, qTokens, e) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(6, Math.max(1, limit)))
      .map((x) => x.e);

    return scored.length ? scored : this.entries.slice(0, 1);
  }

  buildContext(query: string): string {
    const hits = this.retrieve(query, 4);
    if (!hits.length) return '';
    const lines = hits.map((h, i) => {
      const head = [h.category ? `[${h.category}]` : '', h.question].filter(Boolean).join(' ').trim();
      const answer = this.clean(h.answer).slice(0, 1400);
      return `${i + 1}. ${head}\nJawaban rujukan: ${answer}${h.source ? `\nSumber: ${h.source}` : ''}`;
    });
    return `Konteks dataset lokal HukumIn (gunakan sebagai rujukan utama; jangan mengarang fakta baru):\n${lines.join('\n\n')}`;
  }

  private score(query: string, qTokens: string[], e: DatasetEntry): number {
    const hay = this.normalize([e.question, e.answer, e.category, ...(e.keywords ?? [])].filter(Boolean).join(' '));
    let s = 0;
    for (const k of e.keywords ?? []) {
      const nk = this.normalize(k);
      if (nk && (query.includes(nk) || nk.includes(query))) s += 8;
    }
    for (const t of qTokens) {
      if (t.length < 2) continue;
      if (hay.includes(t)) s += t.length >= 4 ? 3 : 1;
    }
    const nq = this.normalize(e.question);
    if (nq && (query.includes(nq) || nq.includes(query))) s += 6;
    return s;
  }

  private parse(raw: string, file: string): DatasetEntry[] {
    const ext = file.toLowerCase();
    if (ext.endsWith('.jsonl')) return this.parseJsonl(raw);
    if (ext.endsWith('.csv') || ext.endsWith('.tsv')) return this.parseCsv(raw, ext.endsWith('.tsv') ? '\t' : ',');
    const data = JSON.parse(raw) as unknown;
    const arr: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).items)
        ? ((data as Record<string, unknown>).items as unknown[])
        : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).data)
          ? ((data as Record<string, unknown>).data as unknown[])
          : [];
    return arr.map((x: unknown, i: number) => this.toEntry(x, i)).filter((x): x is DatasetEntry => !!x);
  }

  private parseJsonl(raw: string): DatasetEntry[] {
    return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l, i) => {
      try { return this.toEntry(JSON.parse(l) as unknown, i); } catch { return null; }
    }).filter((x): x is DatasetEntry => !!x);
  }

  private parseCsv(raw: string, delim: string): DatasetEntry[] {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
    if (lines.length < 2) return [];
    const headers = this.csvRow(lines[0], delim).map((h) => this.normalize(h));
    return lines.slice(1).map((line, i) => {
      const cols = this.csvRow(line, delim);
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ''; });
      return this.toEntry(obj, i);
    }).filter((x): x is DatasetEntry => !!x);
  }

  private csvRow(line: string, delim: string): string[] {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === delim && !q) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  private toEntry(x: unknown, i: number): DatasetEntry | null {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const question = this.clean(o.question ?? o.prompt ?? o.input ?? o.q ?? o.title ?? o.perkara ?? o.kasus ?? '');
    const answer = this.clean(o.answer ?? o.response ?? o.output ?? o.a ?? o.jawaban ?? o.solusi ?? o.penjelasan ?? o.content ?? '');
    if (!question && !answer) return null;
    const kwRaw = o.keywords ?? o.tags ?? o.kata_kunci ?? o.kategori_keyword ?? o.intent;
    const keywords = Array.isArray(kwRaw) ? kwRaw.map((k) => this.clean(k)).filter(Boolean)
      : typeof kwRaw === 'string' ? kwRaw.split(/[,;|]/).map((k) => this.clean(k)).filter(Boolean) : [];
    return {
      id: this.clean(o.id ?? o.code ?? o.kode ?? `ds-${i + 1}`) || `ds-${i + 1}`,
      keywords,
      question: question || answer.slice(0, 120),
      answer: answer || question,
      category: this.clean(o.category ?? o.kategori ?? o.topic ?? o.bidang ?? o.jenis ?? '') || undefined,
      source: this.clean(o.source ?? o.sumber ?? o.reference ?? o.dasar_hukum ?? '') || undefined,
    };
  }

  private resolvePath(p: string) { return isAbsolute(p) ? p : resolve(process.cwd(), p); }
  private clean(v: unknown) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
  private normalize(s: string) { return this.clean(s).toLowerCase(); }
  private tokens(s: string) { return [...new Set(this.normalize(s).split(/[^a-z0-9\u00C0-\u024f]+/i).filter((t) => t.length > 1))]; }
}
