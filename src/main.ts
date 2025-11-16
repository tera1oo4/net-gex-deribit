import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import * as path from 'path';
import * as fs from 'fs';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CORS
  app.enableCors();

  // Serve static files from public folder
  const publicPath = path.join(__dirname, '..', 'public');
  
  if (fs.existsSync(publicPath)) {
    app.useStaticAssets(publicPath, {
      prefix: '/',
      maxAge: '1d',
      etag: false,
    });
  }

  // Default route to index.html for non-API routes
  app.use((req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api')) {
      return next();
    }
    
    // Skip files with extensions
    if (req.path.includes('.')) {
      return next();
    }
    
    // Serve index.html
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`✓ App is running on port ${port}`);
}

bootstrap();
