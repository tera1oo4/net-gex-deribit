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


  async getOrderBookGamma(instrumentName: string): Promise<any> {
    try {
      console.log(`🔄 Starting order book gamma fetch for ${instrumentName}...`);

      // 1. Get order book data
      console.log(`📊 Fetching order book for ${instrumentName}...`);
      const orderBookUrl = `${CONFIG.BASE_URL}/get_order_book?instrument_name=${instrumentName}`;
      const orderBookData = await this.fetchWithRetry<any>(orderBookUrl);
      console.log(`✓ Got order book data for ${instrumentName}`);

      // 2. Get instrument details to calculate gamma
      console.log(`📋 Fetching instrument details for ${instrumentName}...`);
      const instrumentUrl = `${CONFIG.BASE_URL}/get_instrument?instrument_name=${instrumentName}`;
      const instrumentData = await this.fetchWithRetry<any>(instrumentUrl);
      console.log(`✓ Got instrument details for ${instrumentName}`);

      // 3. Calculate gamma from order book data
      const gammaData = this.calculateOrderBookGamma(orderBookData, instrumentData);

      return {
        instrument_name: instrumentName,
        timestamp: new Date().toISOString(),
        gamma_data: gammaData,
        raw_data: {
          order_book: orderBookData,
          instrument: instrumentData
        }
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to fetch order book gamma for ${instrumentName}:`, errorMsg);
      throw new Error(`Failed to fetch order book gamma: ${errorMsg}`);
    }
  }

  private calculateOrderBookGamma(orderBookData: any, instrumentData: any): any {
    try {
      console.log('Calculating order book gamma...');
      console.log('Order book data:', JSON.stringify(orderBookData, null, 2));
      console.log('Instrument data:', JSON.stringify(instrumentData, null, 2));

      const instrument = instrumentData;
      const orderBook = orderBookData;

      if (!instrument || !orderBook) {
        throw new Error('Invalid data structure');
      }

      const { mark_price, mark_iv, underlying_price, greeks } = orderBook;
      const { bids, asks } = orderBook;

      console.log('Order book details:', { mark_price, mark_iv, underlying_price, greeks });
      console.log('Order book details:', { bids: bids?.length, asks: asks?.length });

      // Use the gamma from the order book greeks if available
      const gammaFromAPI = greeks?.gamma;

      let totalBidGamma = 0;
      let totalAskGamma = 0;
      let bidCount = 0;
      let askCount = 0;

      // Calculate gamma for bid levels
      if (bids && bids.length > 0) {
        bids.forEach((bid: any) => {
          const price = bid[0]; // Price level
          const quantity = bid[1]; // Quantity at this price level
          // Use API gamma if available, otherwise calculate
          const gamma = gammaFromAPI;
          totalBidGamma += gamma * quantity;
          bidCount++;
        });
      }

      // Calculate gamma for ask levels
      if (asks && asks.length > 0) {
        asks.forEach((ask: any) => {
          const price = ask[0]; // Price level
          const quantity = ask[1]; // Quantity at this price level
          // Use API gamma if available, otherwise calculate
          const gamma = gammaFromAPI;
          totalAskGamma += gamma * quantity;
          askCount++;
        });
      }

      const result = {
        instrument_name: orderBook.instrument_name,
        gamma_from_api: gammaFromAPI,
        total_bid_gamma: totalBidGamma,
        total_ask_gamma: totalAskGamma,
        net_gamma: totalAskGamma - totalBidGamma,
        bid_levels: bidCount,
        ask_levels: askCount,
        gamma_exposure_usd: Math.abs(totalAskGamma - totalBidGamma)
      };

      console.log('Calculation result:', result);

      return result;
    } catch (error) {
      console.error('Error calculating order book gamma:', error);
      throw new Error(`Failed to calculate order book gamma: ${error instanceof Error ? error.message : String(error)}`);
    }
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

      // Process instruments in batches to avoid too many concurrent requests
      const batchSize = 50;
      for (let i = 0; i < instruments.length; i += batchSize) {
        const batch = instruments.slice(i, i + batchSize);
        console.log(`🔄 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(instruments.length / batchSize)}...`);

        const batchPromises = batch.map(async (instrument: any) => {
          try {
            const { instrument_name, strike, expiration_timestamp, option_type, instrument_id } =
              instrument;
            const marketData = marketDataMap[instrument_name];

            if (!marketData) {
              skippedCount++;
              return;
            }

            // Get order book data to extract gamma from greeks
            let gammaFromAPI = 0;
            if (instrument_id) {
              try {
                const orderBookUrl = `${CONFIG.BASE_URL}/get_order_book?instrument_name=${instrument_name}`;
                const orderBookData = await this.fetchWithRetry<any>(orderBookUrl);
                gammaFromAPI = orderBookData.greeks?.gamma;
              } catch (error) {
                console.warn(`Failed to get order book for ${instrument_name}: ${error instanceof Error ? error.message : String(error)}`);
                gammaFromAPI = 0;
              }
            }

            // Получаем данные из API и рассчитываем net GEX напрямую
            const openInterest = (marketData.open_interest || 0) as number;
            const markIv = (marketData.mark_iv || 0) as number / 100; // конвертируем из процентов в десятичное число
            const timeToExpiry = (expiration_timestamp - now) / (1000 * 60 * 60 * 24 * 365); // в годах

            let netGEX = 0;
            if (openInterest > 0 && markIv > 0 && timeToExpiry > 0) {
              // Используем гамму из order book API
              const gammaFromOrderBook = gammaFromAPI;

              // GEX per contract: GEX = Gamma × OpenInterest × 100
              const gex = openInterest * gammaFromOrderBook * 100;

              // GEX USD = GEX × Price
              const gexUSD = gex * indexPrice;

              // Учитываем тип опциона (call/put) для знака
              if (option_type === 'put') {
                netGEX = -gex; // put опционы имеют отрицательный net GEX
              } else {
                netGEX = gex; // call опционы имеют положительный net GEX
              }

              // Используем GEX и GEX USD напрямую
              const gammaExposure = Math.abs(gex);
              const gammaExposureUSD = Math.abs(gexUSD);

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
                gamma: gammaFromOrderBook,
                open_interest: openInterest,
                gamma_exposure: gammaExposure,
                gamma_exposure_usd: gammaExposureUSD,
                mark_iv: markIv,
                mark_price: marketData.mark_price || 0,
                volume_24h: marketData.volume || marketData.volume_24h || marketData.stats?.volume || marketData.stats?.volume_24h || 0,
                bid_volume: marketData.bid_volume || marketData.stats?.volume_bid || marketData.stats?.bid_volume || 0,
                ask_volume: marketData.ask_volume || marketData.stats?.volume_ask || marketData.stats?.ask_volume || 0
              });
            }
          } catch (error) {
            console.warn(
              `Failed to process instrument: ${error instanceof Error ? error.message : String(error)}`,
            );
            skippedCount++;
          }
        });

        await Promise.all(batchPromises);
      }

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
