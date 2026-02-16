require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const Table = require('cli-table3');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1';
const SITE_URL = 'http://localhost:3050';
const SITE_NAME = 'Free Models Lister';

async function getAvailableFreeModels() {
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
    .filter(model => typeof model?.id === 'string' && model.id.endsWith(':free') && !model?.archived)
    .map(model => ({
      id: model.id,
      name: model.name || model.id,
      contextLength: model.context_length || '-',
      modality: model.architecture?.modality || '-'
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  if (!OPENROUTER_API_KEY) {
    console.error('⚠️  Error: Falta OPENROUTER_API_KEY en el archivo .env');
    process.exit(1);
  }

  const models = await getAvailableFreeModels();

  if (!models.length) {
    console.log('No hay modelos gratuitos disponibles en OpenRouter en este momento.');
    return;
  }

  const table = new Table({
    head: ['Nombre', 'ID', 'Context', 'Modalidad'],
    colWidths: [35, 55, 12, 12],
    wordWrap: true,
    style: { head: ['cyan'] }
  });

  for (const model of models) {
    table.push([model.name, model.id, model.contextLength, model.modality]);
  }

  console.log(`\n✅ Modelos gratuitos disponibles: ${models.length}\n`);
  console.log(table.toString());
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});