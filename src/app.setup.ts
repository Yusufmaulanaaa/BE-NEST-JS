import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';

export function configureApp(app: INestApplication) {
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  const raw = (process.env.CORS_ORIGIN ?? '*').trim();
  const origins = raw === '*' ? true : raw.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: true, methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS' });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
