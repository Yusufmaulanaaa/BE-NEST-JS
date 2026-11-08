import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LawyersService } from '../lawyers/lawyers.service';
import { AiService, ChatTurn } from './ai.service';
import { SendMessageDto } from './chat.dto';
import { Conversation, Message } from './chat.entity';
import { LegalQaService } from './legal-qa.service';

const HISTORY_LIMIT = 20;

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(Conversation) private readonly convs: Repository<Conversation>,
    @InjectRepository(Message) private readonly msgs: Repository<Message>,
    private readonly ai: AiService,
    private readonly lawyers: LawyersService,
    private readonly legalQa: LegalQaService,
  ) {}

  private async ownConversation(userId: string, id: string) {
    const conv = await this.convs.findOne({ where: { id, userId } });
    if (!conv) throw new NotFoundException('Percakapan tidak ditemukan');
    return conv;
  }

  async send(userId: string, dto: SendMessageDto) {
    const text = dto.message.trim();
    const conv = dto.conversationId
      ? await this.ownConversation(userId, dto.conversationId)
      : await this.convs.save(this.convs.create({ userId, title: text.slice(0, 60) }));

    await this.msgs.save(this.msgs.create({ conversationId: conv.id, role: 'user', content: text }));

    const recent = (
      await this.msgs.find({ where: { conversationId: conv.id }, order: { id: 'DESC' }, take: HISTORY_LIMIT })
    ).reverse();
    // API mewajibkan giliran dimulai oleh 'user'.
    while (recent.length && recent[0].role !== 'user') recent.shift();
    const history: ChatTurn[] = recent.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const { text: replyText, qa } = await this.ai.reply(history, text);
    const reply = await this.msgs.save(
      this.msgs.create({ conversationId: conv.id, role: 'assistant', content: replyText }),
    );
    await this.convs.update(conv.id, { title: conv.title });

    return {
      conversationId: conv.id,
      message: { id: reply.id, role: reply.role, content: reply.content, createdAt: reply.createdAt },
      lawyers: await this.lawyers.recommend(text),
      dataset: {
        source: this.legalQa.hasPrimaryDataset ? 'gabungan dataset' : 'dataset contoh',
        intent: qa.intent,
        category: qa.category,
        similarity: Number(qa.score.toFixed(3)),
        link: qa.link,
        question: qa.question,
      },
    };
  }

  list(userId: string) {
    return this.convs.find({ where: { userId }, order: { updatedAt: 'DESC' }, take: 50 });
  }

  datasetStatus() {
    return this.ai.getDatasetStatus();
  }

  async detail(userId: string, id: string) {
    const conv = await this.ownConversation(userId, id);
    const messages = await this.msgs.find({ where: { conversationId: id }, order: { id: 'ASC' } });
    return { ...conv, messages };
  }

  async remove(userId: string, id: string) {
    const conv = await this.ownConversation(userId, id);
    await this.msgs.delete({ conversationId: conv.id });
    await this.convs.delete(conv.id);
  }
}

