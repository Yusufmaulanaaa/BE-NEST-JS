import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Lawyer } from '../lawyers/lawyer.entity';

export type BookingType = 'video' | 'voice' | 'in_person';
export type BookingStatus = 'upcoming' | 'completed' | 'cancelled';

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() lawyerId: string;
  @ManyToOne(() => Lawyer, { eager: true }) @JoinColumn({ name: 'lawyerId' }) lawyer: Lawyer;
  /** Format YYYY-MM-DD */
  @Column() date: string;
  /** Format HH:mm */
  @Column() time: string;
  @Column() type: string;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ default: 'upcoming' }) status: string;
  /** Total biaya dalam Rupiah */
  @Column('int') totalPrice: number;
  @CreateDateColumn() createdAt: Date;
}
