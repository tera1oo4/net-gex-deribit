export interface GammaData {
  [key: string]: {
    total_gamma: number;
    total_gamma_usd: number;
    call_gamma: number;
    call_gamma_usd: number;
    put_gamma: number;
    put_gamma_usd: number;
  };
}

export interface MarketData {
  [key: string]: any;
}

export interface GammaResponse {
  gammaByExpiration: GammaData;
  indexPrice: number;
}
