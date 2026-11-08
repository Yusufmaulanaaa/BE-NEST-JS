import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() title: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
  @OneToMany(() => Message, (m) => m.conversation) messages: Message[];
}

@Entity('messages')
export class Message {
  /** Auto-increment agar urutan pesan selalu tepat. */
  @PrimaryGeneratedColumn('increment') id: number;
  @Column() conversationId: string;
  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' }) conversation: Conversation;
  @Column() role: string; // 'user' | 'assistant'
  @Column('text') content: string;
  @CreateDateColumn() createdAt: Date;
}
