import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { GammaService } from './gamma.service';
import { GammaResponse } from '../types/gamma.types';

@Controller('api')
export class GammaController {
  private readonly logger = new Logger(GammaController.name);

  constructor(private readonly gammaService: GammaService) {}

  @Get('gamma')
  async getGamma(): Promise<GammaResponse> {
    try {
      this.logger.log('📨 API request: GET /api/gamma');
      const data = await this.gammaService.getGammaData();
      this.logger.log('✓ Successfully returned gamma data');
      return data;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`❌ Error in getGamma: ${message}`, error);
      throw new HttpException(
        {
          error: message,
          status: 'error',
          timestamp: new Date().toISOString()
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'gamma-calculator',
      environment: process.env.NODE_ENV || 'unknown'
    };
  }
}
