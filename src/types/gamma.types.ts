export interface Instrument {
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

export interface ExpirationData {
  total_gamma: number;
  total_gamma_usd: number;
  call_gamma: number;
  call_gamma_usd: number;
  put_gamma: number;
  put_gamma_usd: number;
  instruments: Instrument[];
}

export interface GammaData {
  [key: string]: ExpirationData;
}

export interface MarketData {
  [key: string]: any;
}

export interface GammaResponse {
  gammaByExpiration: GammaData;
  indexPrice: number;
  gexFlipLevel: number | null;  // Strike where Net GEX crosses zero
  maxGexStrike: number | null;  // Strike with maximum |Net GEX|
  maxGexValue: number;           // Value of maximum Net GEX
}
