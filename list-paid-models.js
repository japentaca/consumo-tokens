require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const Table = require('cli-table3');
const fs = require('fs/promises');
const path = require('path');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1';
const SITE_URL = 'http://localhost:3050';
const SITE_NAME = 'Paid Models Lister';
const PAID_MODELS_MARKDOWN_PATH = path.join(__dirname, 'paid-models.md');

function parsePricePerToken(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number.parseFloat(String(value));
  return Number.isFinite(numeric) ? numeric : null;
}

function toPerMillion(pricePerToken) {
  if (pricePerToken === null) {
    return null;
  }

  return pricePerToken * 1_000_000;
}

function formatUsd(value) {
  if (value === null) {
    return '-';
  }

  return `$${value.toFixed(4)}`;
}

function escapeMdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function getSortPrice(model) {
  const hasInput = model.inputPerMillion !== null;
  const hasOutput = model.outputPerMillion !== null;

  if (hasInput && hasOutput) {
    return (model.inputPerMillion + model.outputPerMillion) / 2;
  }

  if (hasInput) {
    return model.inputPerMillion;
  }

  if (hasOutput) {
    return model.outputPerMillion;
  }

  return Number.POSITIVE_INFINITY;
}

async function getAvailablePaidModels() {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': SITE_URL,
      'X-Title': SITE_NAME
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Error ${response.status}: ${errorData.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const models = Array.isArray(data?.data) ? data.data : [];

  return models
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
        outputPerMillion,
        avgPerMillion: getSortPrice({ inputPerMillion, outputPerMillion }),
        contextLength: model.context_length || '-',
        modality: model.architecture?.modality || '-'
      };
    })
    .sort((a, b) => {
      const diff = a.avgPerMillion - b.avgPerMillion;
      if (diff !== 0) {
        return diff;
      }

      return a.name.localeCompare(b.name);
    });
}

function buildPaidModelsMarkdown(models) {
  const generatedAt = new Date().toISOString();
  const lines = [];

  lines.push('# Modelos pagos OpenRouter');
  lines.push('');
  lines.push(`_Generado: ${generatedAt}_`);
  lines.push('');
  lines.push(`Total de modelos: ${models.length}`);
  lines.push('');
  lines.push('| Nombre | ID | Input $/1M | Output $/1M | Promedio $/1M | Context | Modalidad |');
  lines.push('|---|---|---:|---:|---:|---:|---|');

  for (const model of models) {
    const avgDisplay = Number.isFinite(model.avgPerMillion) ? formatUsd(model.avgPerMillion) : '-';
    lines.push(`| ${escapeMdCell(model.name)} | ${escapeMdCell(model.id)} | ${formatUsd(model.inputPerMillion)} | ${formatUsd(model.outputPerMillion)} | ${avgDisplay} | ${escapeMdCell(model.contextLength)} | ${escapeMdCell(model.modality)} |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writePaidModelsMarkdown(models) {
  const markdown = buildPaidModelsMarkdown(models);
  await fs.writeFile(PAID_MODELS_MARKDOWN_PATH, markdown, 'utf8');
}

async function main() {
  if (!OPENROUTER_API_KEY) {
    console.error('⚠️  Error: Falta OPENROUTER_API_KEY en el archivo .env');
    process.exit(1);
  }

  const models = await getAvailablePaidModels();

  if (!models.length) {
    console.log('No hay modelos pagos disponibles en OpenRouter en este momento.');
    return;
  }

  const table = new Table({
    head: ['Nombre', 'ID', 'Input $/1M', 'Output $/1M', 'Promedio $/1M', 'Context', 'Modalidad'],
    colWidths: [28, 48, 14, 14, 16, 10, 12],
    wordWrap: true,
    style: { head: ['cyan'] }
  });

  for (const model of models) {
    const avgDisplay = Number.isFinite(model.avgPerMillion) ? formatUsd(model.avgPerMillion) : '-';

    table.push([
      model.name,
      model.id,
      formatUsd(model.inputPerMillion),
      formatUsd(model.outputPerMillion),
      avgDisplay,
      model.contextLength,
      model.modality
    ]);
  }

  await writePaidModelsMarkdown(models);

  console.log(`\n✅ Modelos pagos disponibles (ordenados por precio estimado $/1M): ${models.length}\n`);
  console.log(table.toString());
  console.log(`\n📝 Listado guardado en: ${PAID_MODELS_MARKDOWN_PATH}`);
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
