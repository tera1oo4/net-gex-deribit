import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import * as path from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CORS
  app.enableCors();

  // Serve static files
  const publicPath = path.join(__dirname, '..', 'public');
  app.useStaticAssets(publicPath, {
    prefix: '/',
  });

  // Default route to index.html
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(publicPath, 'index.html'));
    } else {
      next();
    }
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`✓ Server is running on port ${port}`);
}

bootstrap().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
