import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './notification.entity';

@Injectable()
export class NotificationsService {
  constructor(@InjectRepository(Notification) private readonly repo: Repository<Notification>) {}

  notify(userId: string, title: string, body: string) {
    return this.repo.save(this.repo.create({ userId, title, body }));
  }

  async list(userId: string) {
    const items = await this.repo.find({ where: { userId }, order: { id: 'DESC' }, take: 50 });
    return { unreadCount: items.filter((n) => !n.read).length, items };
  }

  async markAllRead(userId: string) {
    await this.repo.update({ userId, read: false }, { read: true });
    return { unreadCount: 0 };
  }
}
