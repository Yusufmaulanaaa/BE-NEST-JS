import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth';
import { SendMessageDto } from './chat.dto';
import { ChatService } from './chat.service';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** Kirim pesan; membuat percakapan baru jika conversationId kosong. */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('messages')
  send(@CurrentUser() user: AuthUser, @Body() dto: SendMessageDto) {
    return this.chat.send(user.id, dto);
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthUser) {
    return this.chat.list(user.id);
  }

  /** Status dataset chatbot (berguna untuk pengecekan koneksi front-end). */
  @Get('dataset')
  dataset() {
    return this.chat.datasetStatus();
  }

  @Get('conversations/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.detail(user.id, id);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.remove(user.id, id);
  }
}
