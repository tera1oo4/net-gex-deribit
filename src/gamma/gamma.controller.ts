import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { GammaService } from './gamma.service';
import { GammaResponse } from '../types/gamma.types';

@Controller('api')
export class GammaController {
  constructor(private readonly gammaService: GammaService) {}

  @Get('gamma')
  async getGamma(): Promise<GammaResponse> {
    try {
      const data = await this.gammaService.getGammaData();
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error in getGamma:', error);
      throw new HttpException(
        { error: message, status: 'error' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
