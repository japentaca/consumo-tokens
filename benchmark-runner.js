require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs/promises');
const path = require('path');
const { createRun, finishRun, saveResult } = require('./database');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1';
const SITE_URL = "http://localhost:3050";
const SITE_NAME = "Token Benchmark Test";

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const PROMPT_LANGS = ['en', 'es', 'zh'];
const INVOCATION_DELAY_MS = Number.parseInt(process.env.INVOCATION_DELAY_MS || '5000', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadTestCasesFromMarkdown() {
  const testCases = [];
  for (const lang of PROMPT_LANGS) {
    const filePath = path.join(PROMPTS_DIR, `${lang}.md`);
    const prompt = (await fs.readFile(filePath, 'utf8')).trim();
    testCases.push({ lang, prompt });
  }
  return testCases;
}

async function fetchModelsCatalog() {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': SITE_URL,
      'X-Title': SITE_NAME
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`No se pudieron consultar modelos: ${response.status} ${errorData.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
}

function getAvailableFreeModels(modelsCatalog) {
  return modelsCatalog
    .filter(model => typeof model?.id === 'string' && !model?.archived)
    .filter(model => model.id.endsWith(':free'))
    .map(model => ({
      id: model.id,
      name: model.name || model.id
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parsePricePerToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number.parseFloat(String(value));
  return Number.isFinite(numeric) ? numeric : null;
}

function toPerMillion(pricePerToken) {
  return pricePerToken === null ? null : pricePerToken * 1_000_000;
}

function getAllPaidModels(modelsCatalog) {
  return modelsCatalog
    .filter(model => typeof model?.id === 'string' && !model?.archived && !model.id.endsWith(':free'))
    .map(model => {
      const inputPerToken = parsePricePerToken(model?.pricing?.prompt);
      const outputPerToken = parsePricePerToken(model?.pricing?.completion);
      const inputPerMillion = toPerMillion(inputPerToken);
      const outputPerMillion = toPerMillion(outputPerToken);
      return {
        id: model.id,
        name: model.name || model.id,
        inputPerMillion,
        outputPerMillion
      };
    })
    .sort((a, b) => {
      const avgA = (a.inputPerMillion || 0) + (a.outputPerMillion || 0);
      const avgB = (b.inputPerMillion || 0) + (b.outputPerMillion || 0);
      return avgA - avgB || a.name.localeCompare(b.name);
    });
}

function selectPaidModelsFromWhitelist(modelsCatalog, whitelist) {
  const catalogById = new Map(
    modelsCatalog
      .filter(model => typeof model?.id === 'string' && !model?.archived)
      .map(model => [model.id, model])
  );

  return whitelist.map(modelId => {
    const model = catalogById.get(modelId);
    const inputPerToken = parsePricePerToken(model?.pricing?.prompt);
    const outputPerToken = parsePricePerToken(model?.pricing?.completion);
    return {
      id: model?.id || modelId,
      name: model?.name || modelId,
      inputPerMillion: toPerMillion(inputPerToken),
      outputPerMillion: toPerMillion(outputPerToken)
    };
  });
}

async function callOpenRouter(modelId, prompt, maxTokens = 300, temperature = 0.1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': SITE_URL,
        'X-Title': SITE_NAME,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: temperature
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Error ${response.status}: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return {
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Timeout de ${REQUEST_TIMEOUT_MS}ms esperando respuesta del modelo.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

class BenchmarkRunner {
  constructor(options) {
    this.models = options.models || [];
    this.source = options.source || 'free';
    this.wss = options.wss;
    this.testCases = [];
    this.totalTests = 0;
    this.completedTests = 0;
    this.runId = null;
  }

  async start() {
    try {
      console.log(`\n🚀 Iniciando benchmark [${this.source}] con ${this.models.length} modelo(s)`);
      this.models.forEach(m => console.log(`   - ${m.name} (${m.id})`));

      this.testCases = await loadTestCasesFromMarkdown();
      this.totalTests = this.models.length * this.testCases.length;
      const maxTokens = 300;
      const temperature = 0.1;
      this.runId = createRun(this.source, this.models.length, maxTokens, temperature);

      console.log(`📊 Run #${this.runId} creado - ${this.totalTests} tests totales`);

      this.broadcast({
        type: 'start',
        totalTests: this.totalTests,
        models: this.models.length,
        runId: this.runId
      });

      for (let i = 0; i < this.models.length; i++) {
        const model = this.models[i];

        this.broadcast({
          type: 'modelStart',
          model: model.name,
          modelIndex: i,
          totalModels: this.models.length
        });

        for (let j = 0; j < this.testCases.length; j++) {
          const testCase = this.testCases[j];

          this.broadcast({
            type: 'testStart',
            model: model.name,
            lang: testCase.lang,
            progress: this.completedTests,
            total: this.totalTests
          });

          try {
            await sleep(INVOCATION_DELAY_MS);
            const usage = await callOpenRouter(model.id, testCase.prompt, maxTokens, temperature);

            const resultData = {
              model: model.name,
              lang: testCase.lang,
              input: usage.input,
              output: usage.output,
              total: usage.total,
              prompt_text: testCase.prompt
            };

            saveResult(this.runId, resultData);

            this.completedTests++;
            console.log(`   ✅ ${model.name} [${testCase.lang}] => ${usage.total} tokens (${this.completedTests}/${this.totalTests})`);
            this.broadcast({
              type: 'result',
              ...resultData,
              progress: this.completedTests,
              total: this.totalTests
            });

          } catch (error) {
            saveResult(this.runId, {
              model: model.name,
              lang: testCase.lang,
              prompt_text: testCase.prompt,
              error: error.message
            });

            this.completedTests++;
            console.log(`   ❌ ${model.name} [${testCase.lang}] => Error: ${error.message} (${this.completedTests}/${this.totalTests})`);
            this.broadcast({
              type: 'error',
              model: model.name,
              lang: testCase.lang,
              error: error.message,
              progress: this.completedTests,
              total: this.totalTests
            });
          }
        }

        this.broadcast({
          type: 'modelComplete',
          model: model.name,
          modelIndex: i
        });
      }

      finishRun(this.runId, 'completed');
      console.log(`\n✅ Benchmark completado - Run #${this.runId}`);
      this.broadcast({
        type: 'complete',
        runId: this.runId,
        totalTests: this.totalTests
      });

    } catch (error) {
      console.error(`\n❌ Error fatal en benchmark:`, error.message);
      try {
        if (this.runId) {
          finishRun(this.runId, 'failed');
        }
      } catch (dbError) {
        console.error('❌ Error actualizando run en DB:', dbError.message);
      }
      this.broadcast({
        type: 'fatalError',
        error: error.message
      });
    }
  }

  broadcast(data) {
    if (!this.wss) return;
    const message = JSON.stringify(data);
    this.wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }
}

async function getAvailableModels() {
  const catalog = await fetchModelsCatalog();
  return {
    free: getAvailableFreeModels(catalog),
    paid: []
  };
}

module.exports = {
  BenchmarkRunner,
  getAvailableModels,
  fetchModelsCatalog,
  getAvailableFreeModels,
  getAllPaidModels,
  selectPaidModelsFromWhitelist
};