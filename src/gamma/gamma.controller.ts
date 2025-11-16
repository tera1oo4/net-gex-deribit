import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { GammaService } from './gamma.service';
import { GammaResponse } from '../types/gamma.types';

@Controller('api')
export class GammaController {
  constructor(private readonly gammaService: GammaService) {}

  @Get('gamma')
  async getGamma(): Promise<GammaResponse> {
    try {
      console.log('📨 API request received for /api/gamma');
      const data = await this.gammaService.getGammaData();
      console.log('✓ Returning gamma data');
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Controller error:', message);
      throw new HttpException(
        { error: message, status: 'error', timestamp: new Date() },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('health')
  getHealth() {
    return { status: 'ok', timestamp: new Date(), service: 'gamma-calculator' };
  }
}
