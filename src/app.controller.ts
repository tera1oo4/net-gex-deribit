import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  getHealth() {
    return { status: 'ok', timestamp: new Date() };
  }

  @Get('ping')
  getPing() {
    return { message: 'pong' };
  }
}
