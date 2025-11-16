const WebSocket = require('ws');
const fs = require('fs');

// Конфигурация
const CONFIG = {
  WS_URL: 'wss://test.deribit.com/ws/api/v2',
  CLIENT_ID: process.env.CLIENT_ID || 'YWTIYiSA',
  CLIENT_SECRET: process.env.CLIENT_SECRET || 'VTyAiD0jUq2X0OWKyKYNBD6FPtmDBg8SUySYph71qNk'
};

let ws;
let requestId = 1;

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(CONFIG.WS_URL);
    
    ws.on('open', () => {
      console.log('✓ WebSocket соединение установлено');
      resolve();
    });
    
    ws.on('error', (error) => {
      console.error('❌ WebSocket ошибка:', error);
      reject(error);
    });
  });
}

function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = requestId++;
    const request = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    };
    
    const messageHandler = (data) => {
      try {
        const message = JSON.parse(data);
        if (message.id === id) {
          ws.removeListener('message', messageHandler);
          if (message.error) {
            reject(new Error(`API Error: ${message.error.message}`));
          } else {
            resolve(message.result);
          }
        }
      } catch (e) {
        reject(e);
      }
    };
    
    ws.on('message', messageHandler);
    
    setTimeout(() => {
      ws.removeListener('message', messageHandler);
      reject(new Error(`Timeout for request ${method}`));
    }, 10000);
    
    ws.send(JSON.stringify(request));
  });
}

async function authenticate() {
  try {
    console.log('🔐 Подключение с API ключом...');
    
    const result = await sendRequest('public/auth', {
      grant_type: 'client_credentials',
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      scope: 'read'
    });
    
    console.log('✓ Аутентификация успешна');
    return result;
  } catch (error) {
    console.error('❌ Ошибка аутентификации:', error.message);
  }
}

async function getIndexPrice(currency) {
  try {
    const indexName = `${currency.toLowerCase()}_usd`;
    const result = await sendRequest('public/get_index_price', { 
      index_name: indexName 
    });
    
    const price = result.index_price;
    console.log(`✓ Получена цена ${currency}: $${price.toFixed(2)}`);
    return price;
  } catch (error) {
    console.error('❌ Ошибка при получении индекса:', error);
    return null;
  }
}

async function getInstruments(currency) {
  try {
    const result = await sendRequest('public/get_instruments', {
      currency: currency,
      kind: 'option'
    });
    console.log(`✓ Получено инструментов: ${result.length}`);
    return result;
  } catch (error) {
    console.error('❌ Ошибка при получении инструментов:', error);
    return [];
  }
}

async function getBookSummary(currency) {
  try {
    const result = await sendRequest('public/get_book_summary_by_currency', {
      currency: currency,
      kind: 'option'
    });
    console.log(`✓ Получено данных по опционам: ${result.length}`);
    return result;
  } catch (error) {
    console.error('❌ Ошибка при получении book summary:', error);
    return [];
  }
}

function calculateGamma(S, K, T, r, sigma) {
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

function calculateGammaInDollars(gamma, indexPrice, openInterest, dS = 100) {
  if (!gamma || gamma === 0) return 0;
  const gammaInDollars = gamma * Math.pow(indexPrice, 2) * openInterest * dS;
  return gammaInDollars;
}

async function calculateGammaByExpiration(currency = 'BTC') {
  try {
    console.log(`\n=== Расчёт гаммы для ${currency} ===\n`);
    
    const indexPrice = await getIndexPrice(currency);
    if (!indexPrice) {
      throw new Error('Не удалось получить цену базового актива');
    }
    
    const instruments = await getInstruments(currency);
    if (!instruments || instruments.length === 0) {
      throw new Error('Не удалось получить список инструментов');
    }
    
    const bookSummary = await getBookSummary(currency);
    if (!bookSummary || bookSummary.length === 0) {
      throw new Error('Не удалось получить рыночные данные');
    }
    
    const marketDataMap = {};
    bookSummary.forEach(item => {
      marketDataMap[item.instrument_name] = item;
    });
    
    console.log(`\n📊 Данные:`);
    console.log(`   Цена ${currency}: $${indexPrice.toFixed(2)}`);
    console.log(`   Инструментов получено: ${instruments.length}`);
    console.log(`   Рыночных данных: ${bookSummary.length}\n`);
    
    const gammaByExpiration = {};
    const now = Date.now();
    const r = 0;
    
    let processedCount = 0;
    let skippedCount = 0;
    
    instruments.forEach(instrument => {
      const { instrument_name, strike, expiration_timestamp, option_type } = instrument;
      const marketData = marketDataMap[instrument_name];
      
      if (!marketData) {
        skippedCount++;
        return;
      }
      
      const S = indexPrice;
      const K = strike;
      const T = (expiration_timestamp - now) / (1000 * 60 * 60 * 24 * 365);
      const sigma = marketData.mark_iv;
      
      const gamma = calculateGamma(S, K, T, r, sigma);
      
      if (gamma === null) {
        skippedCount++;
        return;
      }
      
      processedCount++;
      
      const openInterest = marketData.open_interest || 0;
      const contractSize = 1;
      const gammaExposure = gamma * openInterest * contractSize;
      const gammaExposureUSD = calculateGammaInDollars(gamma, indexPrice, openInterest, 100);
      
      const expirationDate = new Date(expiration_timestamp).toISOString().split('T')[0];
      
      if (!gammaByExpiration[expirationDate]) {
        gammaByExpiration[expirationDate] = {
          expiration_timestamp,
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
    
    console.log(`✓ Обработано инструментов: ${processedCount}`);
    console.log(`⚠️  Пропущено инструментов: ${skippedCount}\n`);
    
    console.log('=== ГАММА ПО ДАТАМ ЭКСПИРАЦИИ ===\n');
    
    const sortedExpirations = Object.keys(gammaByExpiration).sort();
    
    sortedExpirations.forEach(expirationDate => {
      const data = gammaByExpiration[expirationDate];
      console.log(`\nДата экспирации: ${expirationDate}`);
      console.log(`  Общая гамма: ${data.total_gamma.toFixed(6)} (≈ $${data.total_gamma_usd.toFixed(2)}/100bps)`);
      console.log(`  Гамма колов: ${data.call_gamma.toFixed(6)} (≈ $${data.call_gamma_usd.toFixed(2)}/100bps)`);
      console.log(`  Гамма путов: ${data.put_gamma.toFixed(6)} (≈ $${data.put_gamma_usd.toFixed(2)}/100bps)`);
      console.log(`  Инструментов: ${data.instruments.length}`);
      
      const strikeData = {};
      data.instruments.forEach(inst => {
        if (!strikeData[inst.strike]) {
          strikeData[inst.strike] = {
            call_gamma: 0,
            put_gamma: 0,
            call_gamma_usd: 0,
            put_gamma_usd: 0,
            call_oi: 0,
            put_oi: 0
          };
        }
        
        if (inst.option_type === 'call') {
          strikeData[inst.strike].call_gamma += inst.gamma_exposure;
          strikeData[inst.strike].call_gamma_usd += inst.gamma_exposure_usd;
          strikeData[inst.strike].call_oi += inst.open_interest;
        } else {
          strikeData[inst.strike].put_gamma += inst.gamma_exposure;
          strikeData[inst.strike].put_gamma_usd += inst.gamma_exposure_usd;
          strikeData[inst.strike].put_oi += inst.open_interest;
        }
      });
      
      console.log('\n  Гамма по страйкам:');
      console.log('  Strike | Call Gamma | Call USD | Put Gamma | Put USD | Call OI | Put OI');
      console.log('  ' + '-'.repeat(75));
      
      const sortedStrikes = Object.keys(strikeData).map(Number).sort((a, b) => a - b);
      sortedStrikes.forEach(strike => {
        const s = strikeData[strike];
        console.log(`  ${strike.toString().padEnd(6)} | ${s.call_gamma.toFixed(6).padEnd(10)} | $${s.call_gamma_usd.toFixed(0).padEnd(7)} | ${s.put_gamma.toFixed(6).padEnd(9)} | $${s.put_gamma_usd.toFixed(0).padEnd(6)} | ${s.call_oi.toFixed(1).padEnd(7)} | ${s.put_oi.toFixed(1)}`);
      });
      
      const topInstruments = data.instruments
        .sort((a, b) => Math.abs(b.gamma_exposure_usd) - Math.abs(a.gamma_exposure_usd))
        .slice(0, 5);
      
      console.log('\n  Топ-5 по гамма-экспозиции (USD):');
      topInstruments.forEach((inst, idx) => {
        console.log(`    ${idx + 1}. ${inst.instrument_name}`);
        console.log(`       Гамма: ${inst.gamma.toFixed(8)}, OI: ${inst.open_interest}`);
        console.log(`       Гамма-экспозиция: ≈ $${inst.gamma_exposure_usd.toFixed(2)}/100bps`);
      });
    });
    
    ws.close();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    ws.close();
    process.exit(1);
  }
}

// Запуск
(async () => {
  try {
    await connect();
    await authenticate();
    await calculateGammaByExpiration('BTC');
  } catch (error) {
    console.error('❌ Ошибка:', error);
    process.exit(1);
  }
})();
