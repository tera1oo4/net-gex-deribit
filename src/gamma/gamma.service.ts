import { Injectable } from '@nestjs/common';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { GammaData, MarketData, GammaResponse } from '../types/gamma.types';

interface Instrument {
  instrument_name: string;
  strike: number;
  option_type: string;
  gamma: number;
  open_interest: number;
  gamma_exposure: number;
  gamma_exposure_usd: number;
  mark_iv: number;
  mark_price: number;
  volume_24h: number;
  bid_volume: number;
  ask_volume: number;
}

interface GammaExpirationData {
  total_gamma: number;
  total_gamma_usd: number;
  call_gamma: number;
  call_gamma_usd: number;
  put_gamma: number;
  put_gamma_usd: number;
  instruments: Instrument[];
}

interface ApiResponse<T> {
  jsonrpc?: string;
  result?: T;
  error?: {
    message: string;
    code?: number;
  };
  testnet?: boolean;
}

const CONFIG = {
  BASE_URL: 'https://www.deribit.com/api/v2/public',
  TIMEOUT: 15000,
  RETRIES: 2
};

@Injectable()
export class GammaService {
  private async fetchWithRetry<T>(
    url: string,
    retries: number = CONFIG.RETRIES,
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (deribit-gamma-calc)',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Правильная типизация здесь
        const data: ApiResponse<T> = await response.json();

        if (data.error) {
          throw new Error(`API Error: ${data.error.message}`);
        }

        if (data.result !== undefined) {
          return data.result as T;
        }

        return data as unknown as T;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`Attempt ${attempt + 1}/${retries + 1} failed: ${errorMsg}`);

        if (attempt === retries) {
          throw new Error(`Failed after ${retries + 1} attempts: ${errorMsg}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    throw new Error('Unknown error in fetchWithRetry');
  }

  private calculateGamma(
    S: number,
    K: number,
    T: number,
    r: number,
    sigma: number,
  ): number | null {
    if (!S || S <= 0 || !K || K <= 0 || !T || T <= 0 || !sigma || sigma <= 0) {
      return null;
    }

    try {
      const sqrtT = Math.sqrt(T);
      const d1 =
        (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
      const nPrimeD1 =
        (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * d1 * d1);

      // Правильная формула гаммы для Deribit опционов
      // Для BTC/ETH опционов: 1 контракт = 1 единица базового актива
      const contractSize = 1; // 1 BTC или 1 ETH на контракт
      const gamma = (nPrimeD1 / (S * sigma * sqrtT)) * contractSize;

      return isFinite(gamma) ? gamma : null;
    } catch (error) {
      return null;
    }
  }

  private calculateGammaInDollars(
    gamma: number,
    indexPrice: number,
    openInterest: number,
  ): number {
    if (!gamma || gamma === 0) return 0;

    // Новая формула для расчёта гаммы в долларах (GEX)
    // GEX = OI × Γ × 100 × k × S × (1% × S)
    // где k - коэффициент масштабирования (обычно 1)
    const k = 1; // коэффициент масштабирования
    const onePercentOfSpot = 0.01 * indexPrice;
    return openInterest * gamma * 100 * k * indexPrice * onePercentOfSpot;
  }

  async getGammaData(currency: string = 'BTC'): Promise<GammaResponse> {
    try {
      console.log(`🔄 Starting gamma data fetch for ${currency}...`);

      const curr = currency.toUpperCase();
      const indexName = `${curr.toLowerCase()}_usd`;

      // 1. Get index price
      console.log(`📊 Fetching ${curr} price...`);
      const priceUrl = `${CONFIG.BASE_URL}/get_index_price?index_name=${indexName}`;
      const indexPriceData = await this.fetchWithRetry<{
        index_price: number;
      }>(priceUrl);
      const indexPrice = indexPriceData.index_price;
      console.log(`✓ ${curr} Price: $${indexPrice.toFixed(2)}`);

      // 2. Get instruments
      console.log(`📋 Fetching ${curr} instruments...`);
      const instrumentsUrl = `${CONFIG.BASE_URL}/get_instruments?currency=${curr}&kind=option`;
      const instruments = await this.fetchWithRetry<any[]>(instrumentsUrl);
      console.log(`✓ Got ${instruments.length} instruments`);

      // 3. Get book summary
      console.log(`📈 Fetching ${curr} market data...`);
      const bookUrl = `${CONFIG.BASE_URL}/get_book_summary_by_currency?currency=${curr}&kind=option`;
      const bookSummary = await this.fetchWithRetry<any[]>(bookUrl);
      console.log(`✓ Got ${bookSummary.length} market data items`);

      // 4. Process data
      const marketDataMap: MarketData = {};
      bookSummary.forEach((item: any) => {
        marketDataMap[item.instrument_name] = item;
      });

      const gammaByExpiration: { [key: string]: GammaExpirationData } = {};
      const now = Date.now();
      const r = 0;

      let processedCount = 0;
      let skippedCount = 0;

      instruments.forEach((instrument: any) => {
        try {
          const { instrument_name, strike, expiration_timestamp, option_type } =
            instrument;
          const marketData = marketDataMap[instrument_name];

          if (!marketData) {
            skippedCount++;
            return;
          }

          // Получаем данные из API и рассчитываем net GEX напрямую
          const openInterest = (marketData.open_interest || 0) as number;
          const markIv = (marketData.mark_iv || 0) as number / 100; // конвертируем из процентов в десятичное число
          const timeToExpiry = (expiration_timestamp - now) / (1000 * 60 * 60 * 24 * 365); // в годах

          // Рассчитываем net GEX напрямую по формуле:
          // Net GEX = OI × 0.01 × S² × √(T) × N'(d1) / (σ × S × T)
          // где N'(d1) = (1/√(2π)) × e^(-d1²/2)
          // d1 = (ln(S/K) + (r + σ²/2) × T) / (σ × √T)

          let netGEX = 0;
          if (openInterest > 0 && markIv > 0 && timeToExpiry > 0) {
            const S = indexPrice;
            const K = strike as number;
            const r = 0; // безрисковая ставка
            const sigma = markIv;

            const sqrtT = Math.sqrt(timeToExpiry);
            const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * timeToExpiry) / (sigma * sqrtT);
            const nPrimeD1 = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * d1 * d1);

            // Net GEX для одного контракта
            const contractSize = 1; // 1 BTC или 1 ETH на контракт
            const onePercentMove = 0.01 * S;
            netGEX = openInterest * nPrimeD1 * onePercentMove * S * contractSize;

            // Учитываем тип опциона (call/put) для знака
            if (option_type === 'put') {
              netGEX = -netGEX; // put опционы имеют отрицательный net GEX
            }
          }

          // Убираем расчет гаммы и используем net GEX напрямую
          const gammaExposure = Math.abs(netGEX);
          const gammaExposureUSD = Math.abs(netGEX);

          processedCount++;

          const expirationDate = new Date(expiration_timestamp)
            .toISOString()
            .split('T')[0];

          if (!gammaByExpiration[expirationDate]) {
            gammaByExpiration[expirationDate] = {
              total_gamma: 0,
              total_gamma_usd: 0,
              call_gamma: 0,
              call_gamma_usd: 0,
              put_gamma: 0,
              put_gamma_usd: 0,
              instruments: []
            };
          }

          gammaByExpiration[expirationDate].total_gamma += gammaExposure;
          gammaByExpiration[expirationDate].total_gamma_usd +=
            gammaExposureUSD;

          if (option_type === 'call') {
            gammaByExpiration[expirationDate].call_gamma += gammaExposure;
            gammaByExpiration[expirationDate].call_gamma_usd += gammaExposureUSD;
          } else if (option_type === 'put') {
            gammaByExpiration[expirationDate].put_gamma += gammaExposure;
            gammaByExpiration[expirationDate].put_gamma_usd += gammaExposureUSD;
          }

          gammaByExpiration[expirationDate].instruments.push({
            instrument_name,
            strike,
            option_type,
            gamma: 0, //不再使用单独的gamma计算
            open_interest: openInterest,
            gamma_exposure: gammaExposure,
            gamma_exposure_usd: gammaExposureUSD,
            mark_iv: markIv,
            mark_price: marketData.mark_price || 0,
            volume_24h: marketData.volume || marketData.volume_24h || marketData.stats?.volume || marketData.stats?.volume_24h || 0,
            bid_volume: marketData.bid_volume || marketData.stats?.volume_bid || marketData.stats?.bid_volume || 0,
            ask_volume: marketData.ask_volume || marketData.stats?.volume_ask || marketData.stats?.ask_volume || 0
          });
        } catch (error) {
          console.warn(
            `Failed to process instrument: ${error instanceof Error ? error.message : String(error)}`,
          );
          skippedCount++;
        }
      });

      console.log(`✓ Processed: ${processedCount}, Skipped: ${skippedCount}`);

      const sortedExpirations = Object.keys(gammaByExpiration).sort();
      console.log(`✓ Got ${sortedExpirations.length} expiration dates`);

      if (sortedExpirations.length === 0) {
        throw new Error('No expiration dates found in response');
      }

      // Save API data to JSON file
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `gamma-data-${currency.toLowerCase()}-${timestamp}.json`;
        const filePath = join(process.cwd(), 'data', fileName);

        const apiData = {
          timestamp: new Date().toISOString(),
          currency: currency,
          indexPrice: indexPrice,
          processedCount: processedCount,
          skippedCount: skippedCount,
          totalExpirations: sortedExpirations.length,
          expirationDates: sortedExpirations,
          gammaByExpiration: gammaByExpiration,
          rawData: {
            instruments: instruments,
            bookSummary: bookSummary
          }
        };

        // Ensure data directory exists
        const fs = require('fs');
        const dataDir = join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }

        writeFileSync(filePath, JSON.stringify(apiData, null, 2));
        console.log(`📁 API data saved to: ${filePath}`);
      } catch (fileError) {
        console.warn(`⚠️ Failed to save API data to file: ${fileError instanceof Error ? fileError.message : String(fileError)}`);
      }

      return {
        gammaByExpiration: gammaByExpiration as unknown as GammaData,
        indexPrice
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to fetch ${currency} gamma data:`, errorMsg);
      throw new Error(`Failed to fetch gamma data: ${errorMsg}`);
    }
  }
}
