const { NestFactory } = require('@nestjs/core');
const { NestExpressApplication } = require('@nestjs/platform-express');
const { AppModule } = require('../dist/app.module');
const path = require('path');

let app;

async function initApp() {
  if (!app) {
    app = await NestFactory.create(AppModule);
    app.enableCors();
  }
  return app;
}

module.exports = async (req, res) => {
  const application = await initApp();
  
  // Serve static files for root
  if (req.url === '/' || !req.url.startsWith('/api')) {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(__dirname, '../public/index.html'));
    return;
  }

  // API routes
  await application.getHttpAdapter().getInstance()(req, res);
};
