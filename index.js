require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const Table = require('cli-table3');
const fs = require('fs/promises');
const path = require('path');

// ==========================================
// CONFIGURACIÓN OPENROUTER
// ==========================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1';

// Identificación opcional para rankings en openrouter.ai
const SITE_URL = "http://localhost:3050";
const SITE_NAME = "Token Benchmark Test";

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const BLACKLIST_FILE_PATH = path.join(__dirname, '.model-blacklist.json');
const RESULTS_MARKDOWN_PATH = path.join(__dirname, 'benchmark-results.md');
const PROMPT_LANGS = ['en', 'es', 'zh'];
const PREFERRED_FREE_MODELS = (process.env.PREFERRED_FREE_MODELS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const PAID_MODELS_WHITELIST = (process.env.PAID_MODELS_WHITELIST || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MANUAL_BLACKLIST_FREE_MODELS = (process.env.BLACKLIST_FREE_MODELS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MODEL_SOURCE_DEFAULT = (process.env.MODEL_SOURCE || 'free').trim().toLowerCase();
const MAX_MODELS = Number.parseInt(process.env.MAX_MODELS || '0', 10);
const INVOCATION_DELAY_MS = (() => {
  const parsed = Number.parseInt(process.env.INVOCATION_DELAY_MS || '5000', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 5000;
})();
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);
const AUTO_BLACKLIST_402_AFTER = Number.parseInt(process.env.AUTO_BLACKLIST_402_AFTER || '2', 10);
const TARGET_PROVIDER_TAGS = (process.env.TARGET_PROVIDER_TAGS || 'openai,anthropic,gemini,deepseek,qwen,minimax')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);
const AUTO_BLACKLIST_ERROR_PATTERNS = [
  /No endpoints found/i,
  /No endpoints found matching your data policy/i
];
const VALID_MODEL_SOURCES = new Set(['free', 'paid']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// CARGA DE PROMPTS (Markdown)
// ==========================================
async function loadTestCasesFromMarkdown() {
  const testCases = [];

  for (const lang of PROMPT_LANGS) {
    const filePath = path.join(PROMPTS_DIR, `${lang}.md`);
    const prompt = (await fs.readFile(filePath, 'utf8')).trim();

    if (!prompt) {
      throw new Error(`El archivo de prompt está vacío: ${filePath}`);
    }

    testCases.push({ lang, prompt });
  }

  return testCases;
}

async function loadPersistedBlacklist() {
  try {
    const raw = await fs.readFile(BLACKLIST_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter(modelId => typeof modelId === 'string' && modelId.trim().length > 0));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return new Set();
    }

    throw new Error(`No se pudo leer la blacklist en ${BLACKLIST_FILE_PATH}: ${error.message}`);
  }
}

async function savePersistedBlacklist(blacklistSet) {
  const sorted = [...blacklistSet].sort((a, b) => a.localeCompare(b));
  await fs.writeFile(BLACKLIST_FILE_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

function shouldAutoBlacklist(errorMessage) {
  return AUTO_BLACKLIST_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage || ''));
}

function isProvider402Error(errorMessage) {
  return /Error\s*402\b/i.test(errorMessage || '');
}

function getModelSourceFromArgs() {
  const args = process.argv.slice(2);
  const explicitSourceArg = args.find(arg => arg.startsWith('--model-source='));

  if (args.includes('--paid')) {
    return 'paid';
  }

  if (args.includes('--free')) {
    return 'free';
  }

  if (explicitSourceArg) {
    const value = explicitSourceArg.split('=')[1]?.trim().toLowerCase();
    if (VALID_MODEL_SOURCES.has(value)) {
      return value;
    }

    throw new Error(`Valor inválido para --model-source: ${value}. Usa "free" o "paid".`);
  }

  if (VALID_MODEL_SOURCES.has(MODEL_SOURCE_DEFAULT)) {
    return MODEL_SOURCE_DEFAULT;
  }

  throw new Error(`Valor inválido para MODEL_SOURCE en .env: ${MODEL_SOURCE_DEFAULT}. Usa "free" o "paid".`);
}

// ==========================================
// MODELOS GRATUITOS DISPONIBLES
// ==========================================
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

function getAvailableFreeModels(modelsCatalog, blacklistedModelIds = new Set()) {
  return modelsCatalog
    .filter(model => typeof model?.id === 'string' && !model?.archived)
    .filter(model => model.id.endsWith(':free'))
    .filter(model => !blacklistedModelIds.has(model.id))
    .map(model => ({
      id: model.id,
      name: model.name || model.id
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function selectPaidModelsFromWhitelist(modelsCatalog, blacklistedModelIds = new Set()) {
  if (PAID_MODELS_WHITELIST.length === 0) {
    throw new Error('MODEL_SOURCE=paid requiere definir PAID_MODELS_WHITELIST en .env.');
  }

  const catalogById = new Map(
    modelsCatalog
      .filter(model => typeof model?.id === 'string' && !model?.archived)
      .map(model => [model.id, model])
  );

  const selected = [];
  const blacklisted = [];
  const notInCatalog = [];

  for (const modelId of PAID_MODELS_WHITELIST) {
    if (blacklistedModelIds.has(modelId)) {
      blacklisted.push(modelId);
      continue;
    }

    const model = catalogById.get(modelId);
    if (!model) {
      notInCatalog.push(modelId);
      selected.push({ id: modelId, name: modelId });
      continue;
    }

    selected.push({ id: model.id, name: model.name || model.id });
  }

  if (blacklisted.length > 0) {
    console.log(`⛔ Se ignoraron modelos en blacklist: ${blacklisted.join(', ')}`);
  }

  if (notInCatalog.length > 0) {
    console.log(`⚠️  Modelos pagos no encontrados en catálogo actual (se intentarán igual): ${notInCatalog.join(', ')}`);
  }

  if (selected.length === 0) {
    throw new Error('No hay modelos pagos elegibles tras aplicar whitelist/blacklist.');
  }

  if (Number.isInteger(MAX_MODELS) && MAX_MODELS > 0) {
    return selected.slice(0, MAX_MODELS);
  }

  return selected;
}

function modelMatchesProviderTag(modelId, tag) {
  const normalizedId = modelId.toLowerCase();
  const provider = normalizedId.split('/')[0] || '';

  if (tag === 'gemini') {
    return provider === 'google' && normalizedId.includes('/gemini');
  }

  if (tag === 'google') {
    return provider === 'google';
  }

  return provider === tag;
}

function filterModelsByTargetProviders(models) {
  if (TARGET_PROVIDER_TAGS.length === 0) {
    return models;
  }

  return models.filter(model =>
    TARGET_PROVIDER_TAGS.some(tag => modelMatchesProviderTag(model.id, tag))
  );
}

function selectModelsToTest(availableModels, blacklistedModelIds = new Set()) {
  if (!Array.isArray(availableModels) || availableModels.length === 0) {
    return [];
  }

  const availableById = new Map(availableModels.map(model => [model.id, model]));

  let selectedModels;
  if (PREFERRED_FREE_MODELS.length > 0) {
    selectedModels = PREFERRED_FREE_MODELS
      .map(modelId => availableById.get(modelId))
      .filter(Boolean);

    const missing = PREFERRED_FREE_MODELS.filter(modelId => !availableById.has(modelId));
    const missingByBlacklist = missing.filter(modelId => blacklistedModelIds.has(modelId));
    const missingByAvailability = missing.filter(modelId => !blacklistedModelIds.has(modelId));

    if (missing.length > 0) {
      if (missingByAvailability.length > 0) {
        console.log(`⚠️  Se ignoraron modelos no disponibles actualmente: ${missingByAvailability.join(', ')}`);
      }

      if (missingByBlacklist.length > 0) {
        console.log(`⛔ Se ignoraron modelos en blacklist: ${missingByBlacklist.join(', ')}`);
      }
    }

    if (selectedModels.length === 0) {
      if (missingByBlacklist.length > 0 && missingByAvailability.length === 0) {
        throw new Error('Todos los modelos definidos en PREFERRED_FREE_MODELS están actualmente en blacklist. Borra .model-blacklist.json o ajusta BLACKLIST_FREE_MODELS para reintentar.');
      }

      throw new Error('Ninguno de los modelos definidos en PREFERRED_FREE_MODELS existe actualmente como :free en OpenRouter.');
    }
  } else {
    selectedModels = [...availableModels];
  }

  if (Number.isInteger(MAX_MODELS) && MAX_MODELS > 0) {
    selectedModels = selectedModels.slice(0, MAX_MODELS);
  }

  return selectedModels;
}

// ==========================================
// FUNCIÓN DE LLAMADA
// ==========================================
async function callOpenRouter(modelId, prompt) {
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
        max_tokens: 300,
        temperature: 0.1 // Temperatura baja para respuestas consistentes
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Error ${response.status}: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();

    // OpenRouter devuelve usage estándar
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

// ==========================================
// EJECUCIÓN Y REPORTES
// ==========================================
async function runTests() {
  console.log("🚀 Iniciando benchmark de tokens en OpenRouter...\n");

  const modelSource = getModelSourceFromArgs();
  const testCases = await loadTestCasesFromMarkdown();
  const manualBlacklist = new Set(MANUAL_BLACKLIST_FREE_MODELS);
  const persistedBlacklist = await loadPersistedBlacklist();
  const effectiveBlacklist = new Set([...persistedBlacklist, ...manualBlacklist]);
  const modelsCatalog = await fetchModelsCatalog();

  if (manualBlacklist.size > 0) {
    console.log(`⛔ Blacklist manual activa: ${manualBlacklist.size} modelo(s)`);
  }

  if (persistedBlacklist.size > 0) {
    console.log(`🗂️  Blacklist persistida activa: ${persistedBlacklist.size} modelo(s)`);
  }

  let candidateModels = [];
  let modelsToTest = [];

  if (modelSource === 'paid') {
    candidateModels = selectPaidModelsFromWhitelist(modelsCatalog, effectiveBlacklist);
    modelsToTest = [...candidateModels];
  } else {
    const availableFreeModels = getAvailableFreeModels(modelsCatalog, effectiveBlacklist);
    candidateModels = filterModelsByTargetProviders(availableFreeModels);
    modelsToTest = selectModelsToTest(candidateModels, effectiveBlacklist);

    if (candidateModels.length === 0) {
      throw new Error(`No hay modelos gratuitos disponibles para los proveedores/familias solicitados: ${TARGET_PROVIDER_TAGS.join(', ')}.`);
    }
  }

  if (modelsToTest.length === 0) {
    throw new Error('No hay modelos disponibles para evaluar con la configuración actual.');
  }

  console.log(`📝 Prompts cargados: ${testCases.map(t => t.lang.toUpperCase()).join(', ')}`);
  console.log(`🧭 Fuente de modelos: ${modelSource === 'paid' ? 'whitelist pagos' : 'free disponibles'}`);
  console.log(`🤖 Modelos en catálogo: ${modelsCatalog.length}`);
  console.log(`🏷️  Modelos candidatos: ${candidateModels.length}`);
  console.log(`🎯 Modelos a evaluar: ${modelsToTest.length}\n`);

  const results = [];
  const failures = [];
  const model402ErrorCounts = new Map();

  for (const model of modelsToTest) {
    console.log(`🤖 Probando: ${model.name}...`);

    for (const testCase of testCases) {
      try {
        const waitStart = Date.now();
        process.stdout.write(`  ⏳ Esperando ${INVOCATION_DELAY_MS / 1000}s antes de ${testCase.lang.toUpperCase()}...\n`);
        await sleep(INVOCATION_DELAY_MS);
        const waitedMs = Date.now() - waitStart;
        process.stdout.write(`  ⏱️  Espera completada (${(waitedMs / 1000).toFixed(1)}s). Enviando solicitud para ${testCase.lang.toUpperCase()}...\n`);

        const usage = await callOpenRouter(model.id, testCase.prompt);

        results.push({
          model: model.name,
          lang: testCase.lang,
          ...usage
        });

        // Feedback visual en consola
        process.stdout.write(`  ✅ ${testCase.lang.toUpperCase()} completado\n`);

      } catch (error) {
        console.error(`  ❌ Error en ${testCase.lang.toUpperCase()}: ${error.message}`);
        failures.push({
          model: model.name,
          lang: testCase.lang,
          error: error.message
        });

        if (shouldAutoBlacklist(error.message)) {
          if (!effectiveBlacklist.has(model.id)) {
            persistedBlacklist.add(model.id);
            effectiveBlacklist.add(model.id);
            await savePersistedBlacklist(persistedBlacklist);
            console.log(`  ⛔ Modelo agregado a blacklist persistida: ${model.id}`);
          }

          console.log('  ↪️  Se omiten los idiomas restantes para este modelo.');
          break;
        }

        if (isProvider402Error(error.message)) {
          const currentCount = model402ErrorCounts.get(model.id) || 0;
          const nextCount = currentCount + 1;
          model402ErrorCounts.set(model.id, nextCount);

          if (Number.isInteger(AUTO_BLACKLIST_402_AFTER) && AUTO_BLACKLIST_402_AFTER > 0 && nextCount >= AUTO_BLACKLIST_402_AFTER) {
            if (!effectiveBlacklist.has(model.id)) {
              persistedBlacklist.add(model.id);
              effectiveBlacklist.add(model.id);
              await savePersistedBlacklist(persistedBlacklist);
              console.log(`  ⛔ Modelo agregado a blacklist persistida tras ${nextCount} errores 402: ${model.id}`);
            }

            console.log('  ↪️  Se omiten los idiomas restantes para este modelo.');
            break;
          }
        }

        // Continuamos con el siguiente idioma aunque uno falle
      }
    }
    console.log(''); // Salto de línea entre modelos
  }

  printResults(results);
  await writeResultsMarkdown({
    modelSource,
    results,
    failures,
    modelsToTest,
    catalogCount: modelsCatalog.length,
    candidateCount: candidateModels.length
  });
  console.log(`\n📝 Resultados guardados en: ${RESULTS_MARKDOWN_PATH}`);
}

function getRecommendedLang(modelData) {
  const validResults = modelData.filter(r => r.total > 0);
  if (validResults.length === 0) return null;
  return validResults.reduce((best, r) => r.total < best.total ? r : best);
}

function printResults(results) {
  const models = [...new Set(results.map(r => r.model))];
  const langOrder = { en: 0, es: 1, zh: 2 };
  const recommendations = [];

  models.forEach(modelName => {
    const modelData = results.filter(r => r.model === modelName);
    const baseInput = modelData.find(r => r.lang === 'en')?.input || 0;
    const baseTotal = modelData.find(r => r.lang === 'en')?.total || 0;

    const table = new Table({
      head: ['Idioma', 'Input', 'Output', 'Total', 'Diff Input vs EN', 'Diff Total vs EN'],
      colWidths: [10, 10, 10, 10, 20, 20],
      style: { head: ['cyan'] }
    });

    modelData.sort((a, b) => (langOrder[a.lang] ?? 99) - (langOrder[b.lang] ?? 99));

    modelData.forEach(row => {
      let inputDiff = '-';
      let totalDiff = '-';

      if (row.lang !== 'en') {
        if (baseInput > 0) {
          const pct = ((row.input - baseInput) / baseInput) * 100;
          inputDiff = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
        }
        if (baseTotal > 0) {
          const pct = ((row.total - baseTotal) / baseTotal) * 100;
          totalDiff = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
        }
      }

      table.push([
        row.lang.toUpperCase(),
        row.input,
        row.output,
        row.total,
        inputDiff,
        totalDiff
      ]);
    });

    console.log(`\n📊 Resultados: ${modelName}`);
    console.log(table.toString());

    const recommended = getRecommendedLang(modelData);
    if (recommended) {
      recommendations.push({ model: modelName, lang: recommended.lang, input: recommended.input, total: recommended.total });
      console.log(`  🏆 Idioma recomendado: ${recommended.lang.toUpperCase()} (input: ${recommended.input}, total: ${recommended.total})`);
    }
  });

  if (recommendations.length > 0) {
    console.log('\n📋 Resumen de recomendaciones (por menor coste total):');
    recommendations.forEach(r => {
      console.log(`  ${r.model}: ${r.lang.toUpperCase()} (input: ${r.input}, total: ${r.total})`);
    });
  }

  console.log("\n💡 Notas:");
  console.log("   'Diff Input vs EN': coste de tokenización del prompt (relevante para definiciones de proyecto, system prompts).");
  console.log("   'Diff Total vs EN': coste total real (input + output). Los modelos que razonan generan más output según el idioma.");
  console.log("   La recomendación se basa en el coste total (input + output).");
}

function escapeMdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildResultsMarkdown({ modelSource, results, failures, modelsToTest, catalogCount, candidateCount }) {
  const generatedAt = new Date().toISOString();
  const langOrder = { en: 0, es: 1, zh: 2 };
  const models = [...new Set(results.map(r => r.model))];

  const lines = [];
  lines.push('# Benchmark de tokens');
  lines.push('');
  lines.push(`_Generado: ${generatedAt}_`);
  lines.push('');
  lines.push('## Tabla comparativa');
  lines.push('');

  if (results.length === 0) {
    lines.push('No hubo resultados exitosos en esta ejecución.');
    lines.push('');
  } else {
    lines.push('| Modelo | Idioma | Input | Output | Total | Diff Input vs EN | Diff Total vs EN |');
    lines.push('|---|---|---:|---:|---:|---:|---:|');

    const recommendations = [];

    for (const modelName of models.sort((a, b) => a.localeCompare(b))) {
      const modelData = results
        .filter(r => r.model === modelName)
        .sort((a, b) => (langOrder[a.lang] ?? 99) - (langOrder[b.lang] ?? 99));

      const baseInput = modelData.find(r => r.lang === 'en')?.input || 0;
      const baseTotal = modelData.find(r => r.lang === 'en')?.total || 0;

      for (const row of modelData) {
        let inputDiff = '-';
        let totalDiff = '-';

        if (row.lang !== 'en') {
          if (baseInput > 0) {
            const pct = ((row.input - baseInput) / baseInput) * 100;
            inputDiff = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
          }
          if (baseTotal > 0) {
            const pct = ((row.total - baseTotal) / baseTotal) * 100;
            totalDiff = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
          }
        }

        lines.push(`| ${escapeMdCell(row.model)} | ${row.lang.toUpperCase()} | ${row.input} | ${row.output} | ${row.total} | ${inputDiff} | ${totalDiff} |`);
      }

      // Idioma recomendado por menor coste total
      const validResults = modelData.filter(r => r.total > 0);
      if (validResults.length > 0) {
        const best = validResults.reduce((b, r) => r.total < b.total ? r : b);
        recommendations.push({ model: modelName, lang: best.lang, input: best.input, total: best.total });
      }
    }

    lines.push('');

    if (recommendations.length > 0) {
      lines.push('## Recomendación de idioma por modelo');
      lines.push('');
      lines.push('Basado en **tokens totales** (input + output). El input refleja el coste de tokenización del prompt; el output varía según el idioma en modelos que razonan.');
      lines.push('');
      lines.push('| Modelo | Idioma recomendado | Input | Total |');
      lines.push('|---|---|---:|---:|');
      for (const rec of recommendations) {
        lines.push(`| ${escapeMdCell(rec.model)} | ${rec.lang.toUpperCase()} | ${rec.input} | ${rec.total} |`);
      }
      lines.push('');
    }
  }

  lines.push('## Resumen');
  lines.push('');
  lines.push(`- Fuente de modelos: ${modelSource === 'paid' ? 'whitelist pagos' : 'free disponibles'}`);
  lines.push(`- Modelos en catálogo: ${catalogCount}`);
  lines.push(`- Modelos candidatos: ${candidateCount}`);
  lines.push(`- Modelos evaluados: ${modelsToTest.length}`);
  lines.push(`- Resultados exitosos: ${results.length}`);
  lines.push(`- Errores: ${failures.length}`);
  lines.push('');

  if (failures.length > 0) {
    lines.push('## Errores');
    lines.push('');
    lines.push('| Modelo | Idioma | Error |');
    lines.push('|---|---|---|');

    for (const failure of failures) {
      lines.push(`| ${escapeMdCell(failure.model)} | ${failure.lang.toUpperCase()} | ${escapeMdCell(failure.error)} |`);
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function writeResultsMarkdown(payload) {
  const markdown = buildResultsMarkdown(payload);
  await fs.writeFile(RESULTS_MARKDOWN_PATH, markdown, 'utf8');
}

// Validación inicial
if (!OPENROUTER_API_KEY) {
  console.error("⚠️  Error: Falta OPENROUTER_API_KEY en el archivo .env");
  process.exit(1);
}

runTests();