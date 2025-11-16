import { Injectable } from '@nestjs/common';
import * as WebSocket from 'ws';
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

const CONFIG = {
  WS_URL: 'wss://test.deribit.com/ws/api/v2',
  CLIENT_ID: process.env.CLIENT_ID || 'YWTIYiSA',
  CLIENT_SECRET: process.env.CLIENT_SECRET || 'VTyAiD0jUq2X0OWKyKYNBD6FPtmDBg8SUySYph71qNk'
};

@Injectable()
export class GammaService {
  private requestId = 1;

  private sendRequest(ws: WebSocket.WebSocket, method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const request = {
        jsonrpc: '2.0',
        id: id,
        method: method,
        params: params
      };

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout: ${method}`));
      }, 8000);

      const messageHandler = (data: string) => {
        try {
          const message = JSON.parse(data);
          if (message.id === id) {
            clearTimeout(timeout);
            ws.removeListener('message', messageHandler);
            if (message.error) {
              reject(new Error(message.error.message));
            } else {
              resolve(message.result);
            }
          }
        } catch (e) {
          // ignore
        }
      };

      ws.on('message', messageHandler);
      ws.send(JSON.stringify(request));
    });
  }

  private calculateGamma(S: number, K: number, T: number, r: number, sigma: number): number | null {
    if (!S || S <= 0 || !K || K <= 0 || !T || T <= 0 || !sigma || sigma <= 0) {
      return null;
    }

    try {
      const sqrtT = Math.sqrt(T);
      const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
      const nPrimeD1 = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * d1 * d1);
      const gamma = nPrimeD1 / (S * sigma * sqrtT);
      return isFinite(gamma) ? gamma : null;
    } catch (error) {
      return null;
    }
  }

  private calculateGammaInDollars(gamma: number, indexPrice: number, openInterest: number): number {
    if (!gamma || gamma === 0) return 0;
    return gamma * Math.pow(indexPrice, 2) * openInterest * 100;
  }

  async getGammaData(): Promise<GammaResponse> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket.WebSocket(CONFIG.WS_URL);
      let isResolved = false;

      ws.on('error', (error: Error) => {
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      });

      ws.on('open', async () => {
        try {
          // Authenticate
          await this.sendRequest(ws, 'public/auth', {
            grant_type: 'client_credentials',
            client_id: CONFIG.CLIENT_ID,
            client_secret: CONFIG.CLIENT_SECRET,
            scope: 'read'
          });

          // Get data
          const indexPriceResult = await this.sendRequest(ws, 'public/get_index_price', {
            index_name: 'btc_usd'
          });
          const indexPrice = indexPriceResult.index_price as number;

          const instruments = (await this.sendRequest(ws, 'public/get_instruments', {
            currency: 'BTC',
            kind: 'option'
          })) as any[];

          const bookSummary = (await this.sendRequest(ws, 'public/get_book_summary_by_currency', {
            currency: 'BTC',
            kind: 'option'
          })) as any[];

          // Process data
          const marketDataMap: MarketData = {};
          bookSummary.forEach((item: any) => {
            marketDataMap[item.instrument_name] = item;
          });

          const gammaByExpiration: { [key: string]: GammaExpirationData } = {};
          const now = Date.now();
          const r = 0;

          instruments.forEach((instrument: any) => {
            const { instrument_name, strike, expiration_timestamp, option_type } = instrument;
            const marketData = marketDataMap[instrument_name];

            if (!marketData) return;

            const S = indexPrice;
            const K = strike as number;
            const T = (expiration_timestamp - now) / (1000 * 60 * 60 * 24 * 365);
            const sigma = marketData.mark_iv as number;

            const gamma = this.calculateGamma(S, K, T, r, sigma);
            if (gamma === null) return;

            const openInterest = (marketData.open_interest || 0) as number;
            const gammaExposure = gamma * openInterest;
            const gammaExposureUSD = this.calculateGammaInDollars(gamma, indexPrice, openInterest);

            const expirationDate = new Date(expiration_timestamp).toISOString().split('T')[0];

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
            gammaByExpiration[expirationDate].total_gamma_usd += gammaExposureUSD;

            if (option_type === 'call') {
              gammaByExpiration[expirationDate].call_gamma += gammaExposure;
              gammaByExpiration[expirationDate].call_gamma_usd += gammaExposureUSD;
            } else if (option_type === 'put') {
              gammaByExpiration[expirationDate].put_gamma += gammaExposure;
              gammaByExpiration[expirationDate].put_gamma_usd += gammaExposureUSD;
            }

            // ДОБАВЛЯЕМ ИНСТРУМЕНТЫ
            gammaByExpiration[expirationDate].instruments.push({
              instrument_name,
              strike,
              option_type,
              gamma: parseFloat(gamma.toFixed(8)),
              open_interest: openInterest,
              gamma_exposure: gammaExposure,
              gamma_exposure_usd: gammaExposureUSD,
              mark_iv: sigma,
              mark_price: marketData.mark_price || 0
            });
          });

          ws.close();

          if (!isResolved) {
            isResolved = true;
            resolve({ gammaByExpiration: gammaByExpiration as unknown as GammaData, indexPrice });
          }
        } catch (error) {
          ws.close();
          if (!isResolved) {
            isResolved = true;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });

      setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          ws.close();
          reject(new Error('Connection timeout'));
        }
      }, 15000);
    });
  }
}
