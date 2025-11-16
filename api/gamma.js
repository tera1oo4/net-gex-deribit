const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Конфигурация - берём из переменных окружения для Vercel
const CONFIG = {
  WS_URL: 'wss://test.deribit.com/ws/api/v2',
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET
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

function generateHTML(gammaByExpiration, indexPrice) {
  const dates = Object.keys(gammaByExpiration).sort();
  const totalGammas = dates.map(d => gammaByExpiration[d].total_gamma);
  const callGammas = dates.map(d => gammaByExpiration[d].call_gamma);
  const putGammas = dates.map(d => gammaByExpiration[d].put_gamma);
  const totalGammasUSD = dates.map(d => gammaByExpiration[d].total_gamma_usd);
  const callGammasUSD = dates.map(d => gammaByExpiration[d].call_gamma_usd);
  const putGammasUSD = dates.map(d => gammaByExpiration[d].put_gamma_usd);
  
  let strikeCharts = '';
  dates.forEach(expirationDate => {
    const expData = gammaByExpiration[expirationDate];
    const strikes = {};
    
    expData.instruments.forEach(inst => {
      if (!strikes[inst.strike]) {
        strikes[inst.strike] = {
          call_gamma: 0,
          put_gamma: 0,
          call_gamma_usd: 0,
          put_gamma_usd: 0
        };
      }
      
      if (inst.option_type === 'call') {
        strikes[inst.strike].call_gamma += inst.gamma_exposure;
        strikes[inst.strike].call_gamma_usd += inst.gamma_exposure_usd;
      } else {
        strikes[inst.strike].put_gamma += inst.gamma_exposure;
        strikes[inst.strike].put_gamma_usd += inst.gamma_exposure_usd;
      }
    });
    
    const chartId = expirationDate.replace(/-/g, '');
    const chartIdUSD = expirationDate.replace(/-/g, '') + 'USD';
    
    strikeCharts += `
            <div class="chart-wrapper">
                <div class="chart-title">Gamma by Strike - ${expirationDate}</div>
                <canvas id="strikeChart${chartId}"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <div class="chart-title">Gamma USD by Strike - ${expirationDate}</div>
                <canvas id="strikeChartUSD${chartIdUSD}"></canvas>
            </div>
    `;
  });
  
  let checkboxes = '';
  dates.forEach((date, idx) => {
    checkboxes += `<label><input type="checkbox" class="date-filter" value="${date}" ${idx < 3 ? 'checked' : ''} onchange="updateCombinedChart()"> ${date}</label>`;
  });
  
  const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Deribit Gamma Calculator - Real-time Options Analysis</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <meta name="description" content="Real-time Gamma Exposure Calculator for Deribit BTC Options. Analyze gamma profiles by strike and expiration.">
    <meta name="keywords" content="deribit, options, gamma, trading, btc, crypto">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1600px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 10px;
            font-size: 28px;
        }
        
        h2 {
            color: #555;
            text-align: left;
            margin-top: 40px;
            margin-bottom: 20px;
            font-size: 20px;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        
        .timestamp {
            text-align: center;
            color: #666;
            font-size: 12px;
            margin-bottom: 30px;
        }
        
        .price-info {
            text-align: center;
            font-size: 16px;
            color: #2E86AB;
            font-weight: bold;
            margin-bottom: 20px;
            padding: 15px;
            background: #f0f7ff;
            border-radius: 8px;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 8px;
        }
        
        .stat-box {
            text-align: center;
            padding: 15px;
            background: white;
            border-left: 4px solid #2E86AB;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        }
        
        .stat-box.call {
            border-left-color: #06A77D;
        }
        
        .stat-box.put {
            border-left-color: #D62828;
        }
        
        .stat-label {
            font-size: 11px;
            color: #999;
            text-transform: uppercase;
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }
        
        .stat-value {
            font-size: 18px;
            font-weight: bold;
            color: #2E86AB;
            margin-bottom: 5px;
        }
        
        .stat-value.usd {
            font-size: 14px;
            color: #666;
        }
        
        .stat-box.call .stat-value {
            color: #06A77D;
        }
        
        .stat-box.put .stat-value {
            color: #D62828;
        }
        
        .filter-section {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            border-left: 4px solid #667eea;
        }
        
        .filter-title {
            font-weight: bold;
            margin-bottom: 15px;
            color: #333;
            font-size: 14px;
            text-transform: uppercase;
        }
        
        .filter-options {
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        .filter-options label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            font-size: 14px;
            color: #555;
        }
        
        .filter-options input[type="checkbox"] {
            cursor: pointer;
            width: 18px;
            height: 18px;
            accent-color: #667eea;
        }
        
        .filter-options label:hover {
            color: #333;
        }
        
        .charts-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-top: 30px;
        }
        
        .chart-wrapper {
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 20px;
            background: #fafafa;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        }
        
        .chart-title {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 15px;
            color: #333;
            padding-bottom: 10px;
            border-bottom: 2px solid #eee;
        }
        
        canvas {
            max-height: 350px;
        }
        
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            text-align: center;
            color: #999;
            font-size: 12px;
        }
        
        @media (max-width: 1024px) {
            .charts-grid {
                grid-template-columns: 1fr;
            }
        }
        
        @media (max-width: 600px) {
            .container {
                padding: 15px;
            }
            
            h1 {
                font-size: 20px;
            }
            
            .stats {
                grid-template-columns: 1fr;
            }
            
            .filter-options {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 Gamma Exposure Analysis</h1>
        <p class="timestamp">Deribit BTC Options • ${new Date().toLocaleString()}</p>
        <div class="price-info">💰 BTC Price: $${indexPrice.toFixed(2)}</div>
        
        <div class="stats">
            <div class="stat-box">
                <div class="stat-label">📊 Total Gamma</div>
                <div class="stat-value">${totalGammas.reduce((a, b) => a + b, 0).toFixed(6)}</div>
                <div class="stat-value usd">≈ $${totalGammasUSD.reduce((a, b) => a + b, 0).toFixed(0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")}/100bps</div>
            </div>
            <div class="stat-box call">
                <div class="stat-label">📈 Call Gamma</div>
                <div class="stat-value">${callGammas.reduce((a, b) => a + b, 0).toFixed(6)}</div>
                <div class="stat-value usd">≈ $${callGammasUSD.reduce((a, b) => a + b, 0).toFixed(0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")}/100bps</div>
            </div>
            <div class="stat-box put">
                <div class="stat-label">📉 Put Gamma</div>
                <div class="stat-value">${putGammas.reduce((a, b) => a + b, 0).toFixed(6)}</div>
                <div class="stat-value usd">≈ $${putGammasUSD.reduce((a, b) => a + b, 0).toFixed(0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")}/100bps</div>
            </div>
            <div class="stat-box">
                <div class="stat-label">📅 Expiration Dates</div>
                <div class="stat-value">${dates.length}</div>
            </div>
        </div>
        
        <h2>📊 Summary by Expiration</h2>
        <div class="charts-grid">
            <div class="chart-wrapper">
                <div class="chart-title">Total Gamma by Expiration</div>
                <canvas id="totalGammaChart"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <div class="chart-title">Total Gamma in USD (per 100bps move)</div>
                <canvas id="totalGammaUSDChart"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <div class="chart-title">Call vs Put Gamma</div>
                <canvas id="callPutGammaChart"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <div class="chart-title">Call vs Put Gamma USD</div>
                <canvas id="callPutGammaUSDChart"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <div class="chart-title">Stacked Gamma Breakdown</div>
                <canvas id="stackedGammaChart"></canvas>
            </div>
            
            <div class="chart-wrapper">
                <div class="chart-title">Gamma Distribution (Pie)</div>
                <canvas id="pieGammaChart"></canvas>
            </div>
        </div>
        
        <h2>📈 Gamma by Strike (Filtered)</h2>
        <div class="filter-section">
            <div class="filter-title">🔍 Select Expiration Dates:</div>
            <div class="filter-options">
                ${checkboxes}
            </div>
        </div>
        
        <div class="charts-grid">
            <div class="chart-wrapper" style="grid-column: 1 / -1;">
                <div class="chart-title">Combined Gamma USD by Strike (Selected Dates)</div>
                <canvas id="combinedStrikeChartUSD"></canvas>
            </div>
        </div>
        
        <h2>📊 Gamma by Strike (All Dates)</h2>
        <div class="charts-grid">
            ${strikeCharts}
        </div>
        
        <div class="footer">
            Generated by Deribit Gamma Calculator • Real-time data • Gamma USD = Gamma × BTC² × OI × 100
        </div>
    </div>

    <script>
        const dates = ${JSON.stringify(dates)};
        const totalGammas = ${JSON.stringify(totalGammas)};
        const callGammas = ${JSON.stringify(callGammas)};
        const putGammas = ${JSON.stringify(putGammas)};
        const totalGammasUSD = ${JSON.stringify(totalGammasUSD)};
        const callGammasUSD = ${JSON.stringify(callGammasUSD)};
        const putGammasUSD = ${JSON.stringify(putGammasUSD)};
        
        const gammaByExpiration = ${JSON.stringify(gammaByExpiration)};
        
        let combinedChart = null;
        
        const colors = {
            total: 'rgba(46, 134, 171, 0.8)',
            totalBorder: '#1a4d7a',
            call: 'rgba(6, 167, 125, 0.8)',
            callBorder: '#048a5f',
            put: 'rgba(214, 40, 40, 0.8)',
            putBorder: '#b81d1d'
        };
        
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: { size: 12 },
                        padding: 15
                    }
                }
            }
        };
        
        new Chart(document.getElementById('totalGammaChart'), {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Total Gamma',
                    data: totalGammas,
                    backgroundColor: colors.total,
                    borderColor: colors.totalBorder,
                    borderWidth: 2,
                    borderRadius: 4,
                    hoverBackgroundColor: 'rgba(46, 134, 171, 1)',
                    tension: 0.4
                }]
            },
            options: {
                ...chartOptions,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { font: { size: 11 } }
                    },
                    x: {
                        ticks: { font: { size: 10 } }
                    }
                }
            }
        });
        
        new Chart(document.getElementById('totalGammaUSDChart'), {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Total Gamma USD',
                    data: totalGammasUSD,
                    backgroundColor: 'rgba(76, 175, 80, 0.8)',
                    borderColor: '#558b2f',
                    borderWidth: 2,
                    borderRadius: 4,
                    hoverBackgroundColor: 'rgba(76, 175, 80, 1)',
                    tension: 0.4
                }]
            },
            options: {
                ...chartOptions,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { 
                            font: { size: 11 },
                            callback: function(value) {
                                return '$' + value.toLocaleString();
                            }
                        }
                    },
                    x: {
                        ticks: { font: { size: 10 } }
                    }
                }
            }
        });
        
        new Chart(document.getElementById('callPutGammaChart'), {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [
                    {
                        label: 'Call Gamma',
                        data: callGammas,
                        backgroundColor: colors.call,
                        borderColor: colors.callBorder,
                        borderWidth: 2,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(6, 167, 125, 1)'
                    },
                    {
                        label: 'Put Gamma',
                        data: putGammas,
                        backgroundColor: colors.put,
                        borderColor: colors.putBorder,
                        borderWidth: 2,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(214, 40, 40, 1)'
                    }
                ]
            },
            options: {
                ...chartOptions,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { font: { size: 11 } }
                    },
                    x: {
                        ticks: { font: { size: 10 } }
                    }
                }
            }
        });
        
        new Chart(document.getElementById('callPutGammaUSDChart'), {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [
                    {
                        label: 'Call Gamma USD',
                        data: callGammasUSD,
                        backgroundColor: 'rgba(76, 175, 80, 0.8)',
                        borderColor: '#558b2f',
                        borderWidth: 2,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(76, 175, 80, 1)'
                    },
                    {
                        label: 'Put Gamma USD',
                        data: putGammasUSD,
                        backgroundColor: 'rgba(255, 87, 34, 0.8)',
                        borderColor: '#e64a19',
                        borderWidth: 2,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(255, 87, 34, 1)'
                    }
                ]
            },
            options: {
                ...chartOptions,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { 
                            font: { size: 11 },
                            callback: function(value) {
                                return '$' + value.toLocaleString();
                            }
                        }
                    },
                    x: {
                        ticks: { font: { size: 10 } }
                    }
                }
            }
        });
        
        new Chart(document.getElementById('stackedGammaChart'), {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [
                    {
                        label: 'Call Gamma',
                        data: callGammas,
                        backgroundColor: colors.call,
                        borderColor: colors.callBorder,
                        borderWidth: 2,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(6, 167, 125, 1)'
                    },
                    {
                        label: 'Put Gamma',
                        data: putGammas,
                        backgroundColor: colors.put,
                        borderColor: colors.putBorder,
                        borderWidth: 2,
                        borderRadius: 4,
                        hoverBackgroundColor: 'rgba(214, 40, 40, 1)'
                    }
                ]
            },
            options: {
                ...chartOptions,
                scales: {
                    x: {
                        stacked: true,
                        ticks: { font: { size: 10 } }
                    },
                    y: {
                        stacked: true,
                        ticks: { font: { size: 11 } }
                    }
                }
            }
        });
        
        const colorPalette = [
            'rgba(46, 134, 171, 0.8)',
            'rgba(6, 167, 125, 0.8)',
            'rgba(214, 40, 40, 0.8)',
            'rgba(247, 127, 0, 0.8)',
            'rgba(108, 117, 125, 0.8)',
            'rgba(255, 193, 7, 0.8)',
            'rgba(52, 211, 153, 0.8)',
            'rgba(239, 68, 68, 0.8)',
            'rgba(59, 130, 246, 0.8)',
            'rgba(168, 85, 247, 0.8)'
        ];
        
        new Chart(document.getElementById('pieGammaChart'), {
            type: 'doughnut',
            data: {
                labels: dates,
                datasets: [{
                    data: totalGammas,
                    backgroundColor: colorPalette.slice(0, dates.length),
                    borderColor: '#fff',
                    borderWidth: 2
                }]
            },
            options: {
                ...chartOptions,
                plugins: {
                    ...chartOptions.plugins,
                    legend: {
                        ...chartOptions.plugins.legend,
                        position: 'right'
                    }
                }
            }
        });
        
        function updateCombinedChart() {
            const selectedDates = Array.from(document.querySelectorAll('.date-filter:checked')).map(el => el.value);
            
            if (selectedDates.length === 0) {
                alert('Пожалуйста, выберите хотя бы одну дату');
                document.querySelectorAll('.date-filter')[0].checked = true;
                updateCombinedChart();
                return;
            }
            
            const combinedStrikes = {};
            
            selectedDates.forEach(date => {
                const expData = gammaByExpiration[date];
                expData.instruments.forEach(inst => {
                    if (!combinedStrikes[inst.strike]) {
                        combinedStrikes[inst.strike] = {
                            call_gamma_usd: 0,
                            put_gamma_usd: 0
                        };
                    }
                    
                    if (inst.option_type === 'call') {
                        combinedStrikes[inst.strike].call_gamma_usd += inst.gamma_exposure_usd;
                    } else {
                        combinedStrikes[inst.strike].put_gamma_usd += inst.gamma_exposure_usd;
                    }
                });
            });
            
            const sortedStrikes = Object.keys(combinedStrikes).map(Number).sort((a, b) => a - b);
            const callGammasUSDByStrike = sortedStrikes.map(s => combinedStrikes[s].call_gamma_usd);
            const putGammasUSDByStrike = sortedStrikes.map(s => combinedStrikes[s].put_gamma_usd);
            
            const ctx = document.getElementById('combinedStrikeChartUSD').getContext('2d');
            
            if (combinedChart) {
                combinedChart.destroy();
            }
            
            combinedChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: sortedStrikes,
                    datasets: [
                        {
                            label: 'Call Gamma USD',
                            data: callGammasUSDByStrike,
                            backgroundColor: 'rgba(76, 175, 80, 0.8)',
                            borderColor: '#558b2f',
                            borderWidth: 2,
                            borderRadius: 4,
                            hoverBackgroundColor: 'rgba(76, 175, 80, 1)'
                        },
                        {
                            label: 'Put Gamma USD',
                            data: putGammasUSDByStrike,
                            backgroundColor: 'rgba(255, 87, 34, 0.8)',
                            borderColor: '#e64a19',
                            borderWidth: 2,
                            borderRadius: 4,
                            hoverBackgroundColor: 'rgba(255, 87, 34, 1)'
                        }
                    ]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { 
                                font: { size: 11 },
                                callback: function(value) {
                                    return '$' + value.toLocaleString();
                                }
                            }
                        },
                        x: {
                            ticks: { font: { size: 10 } }
                        }
                    }
                }
            });
        }
        
        updateCombinedChart();
        
        dates.forEach(expirationDate => {
            const expData = gammaByExpiration[expirationDate];
            const strikes = {};
            
            expData.instruments.forEach(inst => {
                if (!strikes[inst.strike]) {
                    strikes[inst.strike] = {
                        call_gamma: 0,
                        put_gamma: 0,
                        call_gamma_usd: 0,
                        put_gamma_usd: 0
                    };
                }
                
                if (inst.option_type === 'call') {
                    strikes[inst.strike].call_gamma += inst.gamma_exposure;
                    strikes[inst.strike].call_gamma_usd += inst.gamma_exposure_usd;
                } else {
                    strikes[inst.strike].put_gamma += inst.gamma_exposure;
                    strikes[inst.strike].put_gamma_usd += inst.gamma_exposure_usd;
                }
            });
            
            const sortedStrikes = Object.keys(strikes).map(Number).sort((a, b) => a - b);
            const callGammasByStrike = sortedStrikes.map(s => strikes[s].call_gamma);
            const putGammasByStrike = sortedStrikes.map(s => strikes[s].put_gamma);
            const callGammasUSDByStrike = sortedStrikes.map(s => strikes[s].call_gamma_usd);
            const putGammasUSDByStrike = sortedStrikes.map(s => strikes[s].put_gamma_usd);
            
            const chartId = expirationDate.replace(/-/g, '');
            const chartIdUSD = expirationDate.replace(/-/g, '') + 'USD';
            
            new Chart(document.getElementById('strikeChart' + chartId), {
                type: 'bar',
                data: {
                    labels: sortedStrikes,
                    datasets: [
                        {
                            label: 'Call Gamma',
                            data: callGammasByStrike,
                            backgroundColor: colors.call,
                            borderColor: colors.callBorder,
                            borderWidth: 1,
                            borderRadius: 2,
                            hoverBackgroundColor: 'rgba(6, 167, 125, 1)'
                        },
                        {
                            label: 'Put Gamma',
                            data: putGammasByStrike,
                            backgroundColor: colors.put,
                            borderColor: colors.putBorder,
                            borderWidth: 1,
                            borderRadius: 2,
                            hoverBackgroundColor: 'rgba(214, 40, 40, 1)'
                        }
                    ]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { font: { size: 9 } }
                        },
                        x: {
                            ticks: { font: { size: 8 } }
                        }
                    }
                }
            });
            
            new Chart(document.getElementById('strikeChartUSD' + chartIdUSD), {
                type: 'bar',
                data: {
                    labels: sortedStrikes,
                    datasets: [
                        {
                            label: 'Call Gamma USD',
                            data: callGammasUSDByStrike,
                            backgroundColor: 'rgba(76, 175, 80, 0.8)',
                            borderColor: '#558b2f',
                            borderWidth: 1,
                            borderRadius: 2,
                            hoverBackgroundColor: 'rgba(76, 175, 80, 1)'
                        },
                        {
                            label: 'Put Gamma USD',
                            data: putGammasUSDByStrike,
                            backgroundColor: 'rgba(255, 87, 34, 0.8)',
                            borderColor: '#e64a19',
                            borderWidth: 1,
                            borderRadius: 2,
                            hoverBackgroundColor: 'rgba(255, 87, 34, 1)'
                        }
                    ]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { 
                                font: { size: 9 },
                                callback: function(value) {
                                    return '$' + value.toLocaleString();
                                }
                            }
                        },
                        x: {
                            ticks: { font: { size: 8 } }
                        }
                    }
                }
            });
        });
    </script>
</body>
</html>`;

  return html;
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
    
    return { gammaByExpiration, indexPrice };
    
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    throw error;
  }
}

// Serverless function для Vercel
module.exports = async (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    await connect();
    await authenticate();
    
    const { gammaByExpiration, indexPrice } = await calculateGammaByExpiration('BTC');
    const html = generateHTML(gammaByExpiration, indexPrice);
    
    res.status(200).send(html);
    ws.close();
    
  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
};
