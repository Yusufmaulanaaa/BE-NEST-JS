import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsOptional() @IsUUID() conversationId?: string;
  @IsString() @MinLength(1) @MaxLength(2000) message: string;
}
