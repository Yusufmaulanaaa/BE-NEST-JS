import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';

export function configureApp(app: INestApplication) {
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({ origin: (process.env.CORS_ORIGIN ?? '*').split(',') });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
