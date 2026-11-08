import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatasetService } from './dataset.service';
import { LegalQaResult, LegalQaService } from './legal-qa.service';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

type Provider = 'anthropic' | 'openai_compatible';

interface AiResponse {
  content?: Array<{ type?: string; text?: string }>;
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  error?: { message?: string } | string;
  message?: string;
}

export const SYSTEM_PROMPT = `Kamu adalah "Legal AI" di aplikasi HukumIn, asisten informasi hukum untuk masyarakat Indonesia.
Aturan:
- Jawab dalam bahasa yang dipakai pengguna (default Bahasa Indonesia), singkat, jelas, dan ramah.
- Berikan informasi hukum umum, bukan nasihat hukum resmi. Jangan menjanjikan hasil perkara.
- Jangan mengarang nomor pasal, putusan, atau angka. Jika tidak yakin, katakan tidak yakin dan sarankan memeriksa peraturan terbaru atau bertanya ke pengacara.
- Gunakan hanya konteks dataset lokal yang diberikan; jangan mengarang fakta baru.
- Akhiri dengan satu kalimat pengingat singkat bahwa ini informasi umum, bukan nasihat hukum resmi.`;

/**
 * Sumber jawaban chatbot:
 *  1. Dataset "gabungan dataset" (Legal QA + klasifikasi) -> dipakai sebagai rujukan utama.
 *  2. Bila CHAT_ANSWER_MODE=ai dan AI_API_KEY tersedia, AI eksternal merangkai ulang
 *     jawaban berdasarkan dataset tersebut (tetap grounded, tidak mengarang).
 *  3. Bila dataset tidak tersedia, memakai dataset contoh (data/chatbot-dataset.json).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly dataset: DatasetService,
    private readonly legalQa: LegalQaService,
  ) {}

  /** Mode: 'dataset' (default, jawaban langsung dari dataset) atau 'ai'. */
  get mode(): 'dataset' | 'ai' {
    return (this.config.get<string>('CHAT_ANSWER_MODE') || 'dataset').toLowerCase() === 'ai' ? 'ai' : 'dataset';
  }

  getDatasetStatus() {
    return {
      ...this.legalQa.getStatus(),
      mode: this.mode,
      fallbackDataset: this.dataset.getStatus(),
    };
  }

  async reply(history: ChatTurn[], message: string): Promise<{ text: string; qa: LegalQaResult }> {
    const clean = this.normalizeHistory(history);
    const lastUser = [...clean].reverse().find((m) => m.role === 'user')?.content ?? message ?? '';

    // 1) Intent khusus dari notebook (sapaan / konsultasi / cari advokat).
    const qa = this.legalQa.answer(lastUser);
    if (qa.intent !== 'laporan') {
      return { text: qa.reply, qa };
    }

    // 2) Dataset gabungan (CSV) tersedia -> jawaban diambil dari dataset.
    if (this.legalQa.hasPrimaryDataset) {
      if (this.mode === 'ai') {
        try {
          const text = await this.callProvider(clean, this.legalQa.buildContext(lastUser));
          if (text) return { text, qa };
        } catch (err) {
          this.logger.error(`AI provider gagal, memakai jawaban dataset: ${this.err(err)}`);
        }
      }
      return { text: qa.reply, qa };
    }

    // 3) Fallback: dataset contoh (JSON) bila file CSV belum dipasang.
    const context = this.dataset.buildContext(lastUser);
    if (!clean.length) {
      return {
        text: this.mockReply(context, 'Ceritakan kronologi singkat kasus Anda (waktu, pihak terkait, dan bukti yang ada).'),
        qa,
      };
    }
    return { text: this.mockReply(context), qa };
  }

  private normalizeHistory(history: ChatTurn[]): ChatTurn[] {
    const turns = (history ?? [])
      .filter((m): m is ChatTurn => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.trim() }))
      .filter((m) => m.content.length > 0);
    while (turns.length && turns[0].role !== 'user') turns.shift();
    const merged: ChatTurn[] = [];
    for (const t of turns) {
      const last = merged[merged.length - 1];
      if (last && last.role === t.role) last.content = `${last.content}\n\n${t.content}`.slice(0, 4000);
      else merged.push({ ...t, content: t.content.slice(0, 4000) });
    }
    return merged.slice(-20);
  }

  private systemPrompt(context: string) {
    return context ? `${SYSTEM_PROMPT}\n\n${context}` : SYSTEM_PROMPT;
  }

  private async callProvider(history: ChatTurn[], context: string): Promise<string> {
    const provider = ((this.config.get<string>('AI_PROVIDER') || 'anthropic').toLowerCase()) as Provider;
    const key = this.config.get<string>('AI_API_KEY') || this.config.get<string>('ANTHROPIC_API_KEY');
    if (!key) throw new Error('AI_API_KEY belum diatur');
    if (!history.length) throw new Error('Riwayat chat kosong');
    return provider === 'openai_compatible'
      ? this.callOpenAICompatible(key, history, context)
      : this.callAnthropic(key, history, context);
  }

  private async callAnthropic(key: string, history: ChatTurn[], context: string): Promise<string> {
    const baseUrl = (this.config.get<string>('AI_BASE_URL') || this.config.get<string>('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/$/, '');
    const version = this.config.get<string>('ANTHROPIC_VERSION') || '2023-06-01';
    const model = this.config.get<string>('AI_MODEL') || this.config.get<string>('ANTHROPIC_MODEL') || 'claude-3-5-haiku-latest';
    const maxTokens = this.intConfig('AI_MAX_TOKENS', 1024, 64, 4096);
    const timeoutMs = this.intConfig('AI_TIMEOUT_MS', 30000, 5000, 120000);

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': version },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: this.systemPrompt(context), messages: history }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await this.safeJson(res)) as AiResponse;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${this.errorText(data)}`);
    const text = (data.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
    if (!text) throw new Error('Anthropic response kosong');
    return text;
  }

  private async callOpenAICompatible(key: string, history: ChatTurn[], context: string): Promise<string> {
    const baseUrl = (this.config.get<string>('AI_BASE_URL') || 'http://localhost:11434/v1').replace(/\/$/, '');
    const model = this.config.get<string>('AI_MODEL') || 'gpt-4o-mini';
    const maxTokens = this.intConfig('AI_MAX_TOKENS', 1024, 64, 4096);
    const timeoutMs = this.intConfig('AI_TIMEOUT_MS', 30000, 5000, 120000);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: this.systemPrompt(context) }, ...history],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await this.safeJson(res)) as AiResponse;
    if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}: ${this.errorText(data)}`);
    const content = data.choices?.[0]?.message?.content;
    const text =
      typeof content === 'string'
        ? content.trim()
        : Array.isArray(content)
          ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n').trim()
          : '';
    if (!text) throw new Error('OpenAI-compatible response kosong');
    return text;
  }

  private intConfig(name: string, fallback: number, min: number, max: number): number {
    const raw = Number(this.config.get<string>(name) ?? fallback);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  }

  private async safeJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 500) };
    }
  }

  private errorText(data: AiResponse): string {
    if (typeof data.error === 'string') return data.error;
    if (data.error?.message) return data.error.message;
    if (data.message) return data.message;
    return 'unknown error';
  }

  private mockReply(context: string, extra?: string) {
    const note =
      '\n\n(Mode contoh aktif karena dataset gabungan belum terpasang di server. ' +
      'Informasi ini bersifat umum, bukan nasihat hukum resmi.)';

    if (context) {
      const blocks = context.split(/\n(?=\d+\.\s)/).slice(1);
      const firstBlock = blocks[0] || context;
      const ref = firstBlock
        .split('\n')
        .find((l) => l.startsWith('Jawaban rujukan:'))
        ?.replace('Jawaban rujukan:', '')
        .trim();
      const head = firstBlock.split('\n').find((l) => /^\d+\.\s/.test(l))?.replace(/^\d+\.\s/, '').trim();
      if (ref) {
        const prefix = head ? `Berdasarkan data HukumIn (${head}):\n` : 'Berdasarkan data HukumIn:\n';
        return `${prefix}${ref}${note}`;
      }
    }

    const question = extra ?? 'Ceritakan kronologi singkat kasus Anda (waktu, pihak terkait, dan bukti yang ada).';
    return (
      'Maaf, saya belum menemukan jawaban yang cocok di dataset lokal untuk pertanyaan itu. ' +
      `${question}${note}`
    );
  }

  private err(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}
