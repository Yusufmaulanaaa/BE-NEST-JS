import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('increment') id: number;
  @Column() userId: string;
  @Column() title: string;
  @Column('text') body: string;
  @Column({ default: false }) read: boolean;
  @CreateDateColumn() createdAt: Date;
}
