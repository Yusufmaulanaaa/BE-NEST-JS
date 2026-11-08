import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lawyer, Review } from './lawyer.entity';
import { CreateReviewDto, LawyerQueryDto } from './lawyers.dto';
import { LAWYER_SEED, SPECIALTY_KEYWORDS } from './lawyers.seed';

@Injectable()
export class LawyersService implements OnModuleInit {
  constructor(
    @InjectRepository(Lawyer) private readonly lawyers: Repository<Lawyer>,
    @InjectRepository(Review) private readonly reviews: Repository<Review>,
  ) {}

  async onModuleInit() {
    if ((await this.lawyers.count()) === 0) {
      await this.lawyers.save(LAWYER_SEED.map((s) => this.lawyers.create(s)));
    }
  }

  async search(q: LawyerQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const qb = this.lawyers.createQueryBuilder('l');
    if (q.q) {
      qb.andWhere('(LOWER(l.name) LIKE :q OR LOWER(l.specialty) LIKE :q)', { q: `%${q.q.toLowerCase()}%` });
    }
    if (q.specialty) qb.andWhere('LOWER(l.specialty) LIKE :sp', { sp: `%${q.specialty.toLowerCase()}%` });
    if (q.city) qb.andWhere('LOWER(l.city) = :city', { city: q.city.toLowerCase() });
    if (q.minRating !== undefined) qb.andWhere('l.rating >= :minRating', { minRating: q.minRating });
    if (q.maxPrice !== undefined) qb.andWhere('l.pricePerHour <= :maxPrice', { maxPrice: q.maxPrice });

    if (q.sort === 'price') qb.orderBy('l.pricePerHour', 'ASC');
    else if (q.sort === 'experience') qb.orderBy('l.experienceYears', 'DESC');
    else qb.orderBy('l.rating', 'DESC').addOrderBy('l.reviewCount', 'DESC');

    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { items, total, page, limit };
  }

  async findOne(id: string) {
    const lawyer = await this.lawyers.findOne({ where: { id } });
    if (!lawyer) throw new NotFoundException('Pengacara tidak ditemukan');
    const reviews = await this.reviews.find({
      where: { lawyerId: id },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    return { ...lawyer, reviews };
  }

  async addReview(lawyerId: string, user: { id: string; name: string }, dto: CreateReviewDto) {
    const lawyer = await this.lawyers.findOne({ where: { id: lawyerId } });
    if (!lawyer) throw new NotFoundException('Pengacara tidak ditemukan');
    if (await this.reviews.findOne({ where: { lawyerId, userId: user.id } })) {
      throw new ConflictException('Kamu sudah memberi ulasan untuk pengacara ini');
    }
    const review = await this.reviews.save(
      this.reviews.create({
        lawyerId,
        userId: user.id,
        userName: user.name,
        rating: dto.rating,
        comment: dto.comment?.trim() || null,
      }),
    );
    const total = lawyer.rating * lawyer.reviewCount + dto.rating;
    lawyer.reviewCount += 1;
    lawyer.rating = Math.round((total / lawyer.reviewCount) * 10) / 10;
    await this.lawyers.save(lawyer);
    return review;
  }

  /** Deteksi spesialisasi dari teks pengguna (pencocokan kata kunci sederhana). */
  detectSpecialty(text: string): string | undefined {
    const t = text.toLowerCase();
    return Object.keys(SPECIALTY_KEYWORDS).find((s) => SPECIALTY_KEYWORDS[s].some((k) => t.includes(k)));
  }

  async recommend(text: string, limit = 3) {
    const specialty = this.detectSpecialty(text);
    const qb = this.lawyers.createQueryBuilder('l');
    if (specialty) qb.where('l.specialty = :specialty', { specialty });
    return qb.orderBy('l.rating', 'DESC').take(limit).getMany();
  }
}
