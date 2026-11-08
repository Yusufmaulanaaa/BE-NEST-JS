import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { LawyersModule } from './lawyers/lawyers.module';
import { ChatModule } from './chat/chat.module';
import { BookingsModule } from './bookings/bookings.module';
import { NotificationsModule } from './notifications/notifications.module';

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService): TypeOrmModuleOptions => {
        const url = c.get<string>('DATABASE_URL');
        if (url) {
          return {
            type: 'postgres',
            url,
            autoLoadEntities: true,
            synchronize: c.get('DB_SYNC', 'true') === 'true',
          };
        }
        const path = c.get<string>('SQLITE_PATH', 'hukumin.sqlite');
        return path === ':memory:'
          ? { type: 'sqljs', autoSave: false, autoLoadEntities: true, synchronize: true }
          : { type: 'sqljs', location: path, autoSave: true, autoLoadEntities: true, synchronize: true };
      },
    }),
    AuthModule,
    LawyersModule,
    ChatModule,
    BookingsModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
