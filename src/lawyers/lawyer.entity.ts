import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity('lawyers')
export class Lawyer {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column() role: string;
  @Column() specialty: string;
  @Column() city: string;
  @Column('float') rating: number;
  @Column('int') reviewCount: number;
  @Column('int') experienceYears: number;
  @Column('int') casesHandled: number;
  /** Tarif per jam dalam Rupiah */
  @Column('int') pricePerHour: number;
  @Column() photoUrl: string;
  @Column('text') about: string;
  @Column({ default: true }) verified: boolean;
  @Column('simple-json') practiceAreas: string[];
  @OneToMany(() => Review, (r) => r.lawyer) reviews: Review[];
}

@Entity('reviews')
export class Review {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() lawyerId: string;
  @ManyToOne(() => Lawyer, (l) => l.reviews, { onDelete: 'CASCADE' }) lawyer: Lawyer;
  @Column() userId: string;
  @Column() userName: string;
  @Column('int') rating: number;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @CreateDateColumn() createdAt: Date;
}
