import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Lawyer } from '../lawyers/lawyer.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Booking } from './booking.entity';
import { CreateBookingDto } from './bookings.dto';

export const SLOTS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];

@Injectable()
export class BookingsService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Lawyer) private readonly lawyers: Repository<Lawyer>,
    private readonly notifications: NotificationsService,
  ) {}

  private assertValidSlot(date: string, time: string) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('Tanggal tidak valid');
    }
    if (date < new Date().toISOString().slice(0, 10)) {
      throw new BadRequestException('Tanggal tidak boleh di masa lalu');
    }
    if (!SLOTS.includes(time)) {
      throw new BadRequestException(`Jam tidak tersedia. Pilihan: ${SLOTS.join(', ')}`);
    }
  }

  private async assertFree(lawyerId: string, date: string, time: string, ignoreId?: string) {
    const taken = await this.bookings.findOne({
      where: {
        lawyerId,
        date,
        time,
        status: Not('cancelled'),
        ...(ignoreId ? { id: Not(ignoreId) } : {}),
      },
    });
    if (taken) throw new ConflictException('Jadwal tersebut sudah dipesan');
  }

  async slots(lawyerId: string, date: string) {
    if (!(await this.lawyers.exist({ where: { id: lawyerId } }))) {
      throw new NotFoundException('Pengacara tidak ditemukan');
    }
    const booked = await this.bookings.find({ where: { lawyerId, date, status: Not('cancelled') } });
    const takenTimes = new Set(booked.map((b) => b.time));
    return SLOTS.map((time) => ({ time, available: !takenTimes.has(time) }));
  }

  async create(userId: string, dto: CreateBookingDto) {
    const lawyer = await this.lawyers.findOne({ where: { id: dto.lawyerId } });
    if (!lawyer) throw new NotFoundException('Pengacara tidak ditemukan');
    this.assertValidSlot(dto.date, dto.time);
    await this.assertFree(lawyer.id, dto.date, dto.time);

    const booking = await this.bookings.save(
      this.bookings.create({
        userId,
        lawyerId: lawyer.id,
        date: dto.date,
        time: dto.time,
        type: dto.type,
        note: dto.note?.trim() || null,
        status: 'upcoming',
        totalPrice: lawyer.pricePerHour,
      }),
    );
    await this.notifications.notify(
      userId,
      'Konsultasi terjadwal',
      `Sesi dengan ${lawyer.name} pada ${dto.date} pukul ${dto.time} berhasil dipesan.`,
    );
    return { ...booking, lawyer };
  }

  list(userId: string, status?: string) {
    return this.bookings.find({
      where: { userId, ...(status ? { status } : {}) },
      order: { date: 'DESC', time: 'DESC' },
    });
  }

  private async mine(userId: string, id: string) {
    const booking = await this.bookings.findOne({ where: { id, userId } });
    if (!booking) throw new NotFoundException('Booking tidak ditemukan');
    return booking;
  }

  async cancel(userId: string, id: string) {
    const booking = await this.mine(userId, id);
    if (booking.status !== 'upcoming') throw new BadRequestException('Hanya booking mendatang yang bisa dibatalkan');
    booking.status = 'cancelled';
    await this.bookings.save(booking);
    await this.notifications.notify(userId, 'Booking dibatalkan', `Sesi dengan ${booking.lawyer.name} dibatalkan.`);
    return booking;
  }

  async reschedule(userId: string, id: string, date: string, time: string) {
    const booking = await this.mine(userId, id);
    if (booking.status !== 'upcoming') throw new BadRequestException('Hanya booking mendatang yang bisa dijadwal ulang');
    this.assertValidSlot(date, time);
    await this.assertFree(booking.lawyerId, date, time, booking.id);
    booking.date = date;
    booking.time = time;
    await this.bookings.save(booking);
    await this.notifications.notify(userId, 'Jadwal diubah', `Sesi dengan ${booking.lawyer.name} dipindah ke ${date} pukul ${time}.`);
    return booking;
  }
}
