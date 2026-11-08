import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LawyersModule } from '../lawyers/lawyers.module';
import { AiService } from './ai.service';
import { ChatController } from './chat.controller';
import { Conversation, Message } from './chat.entity';
import { ChatService } from './chat.service';
import { DatasetService } from './dataset.service';
import { LegalQaService } from './legal-qa.service';

@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Message]), LawyersModule],
  controllers: [ChatController],
  providers: [ChatService, AiService, DatasetService, LegalQaService],
})
export class ChatModule {}

