import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query
} from '@nestjs/common';
import { GammaService } from './gamma.service';
import { GammaResponse } from '../types/gamma.types';

@Controller('api')
export class GammaController {
  private readonly logger = new Logger(GammaController.name);

  constructor(private readonly gammaService: GammaService) {}

  @Get('gamma')
  async getGamma(
    @Query('currency') currency: string = 'BTC'
  ): Promise<GammaResponse> {
    try {
      const curr = currency.toUpperCase();
      this.logger.log(`📨 API request: GET /api/gamma?currency=${curr}`);
      
      if (!['BTC', 'ETH'].includes(curr)) {
        throw new Error('Invalid currency. Supported: BTC, ETH');
      }

      const data = await this.gammaService.getGammaData(curr);
      this.logger.log(`✓ Successfully returned ${curr} gamma data`);
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

  @Get('order-book-gamma')
  async getOrderBookGamma(
    @Query('instrument_name') instrumentName: string
  ) {
    try {
      if (!instrumentName) {
        throw new Error('instrument_name parameter is required');
      }

      this.logger.log(`📨 API request: GET /api/order-book-gamma?instrument_name=${instrumentName}`);

      const data = await this.gammaService.getOrderBookGamma(instrumentName);
      this.logger.log(`✓ Successfully returned order book gamma for ${instrumentName}`);
      return data;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`❌ Error in getOrderBookGamma: ${message}`, error);
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
      environment: process.env.NODE_ENV || 'unknown',
      supportedCurrencies: ['BTC', 'ETH']
    };
  }
}
