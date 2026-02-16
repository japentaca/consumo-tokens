# consumo-tokens

Script en Node.js para medir y comparar consumo de tokens por idioma (EN, ES, ZH) usando:

- modelos gratuitos disponibles (`:free`), o
- una whitelist de modelos pagos definida en `.env`.

También incluye una **interfaz web** para ejecutar benchmarks visualmente.

## Interfaz Web

```bash
npm start
```

Luego abre http://localhost:3050 en tu navegador.

La interfaz permite:
- Seleccionar modelos para las pruebas
- Ver resultados en tabla HTML
- Seguimiento en tiempo real via WebSocket
- Guardar resultados en SQLite

## Instalación

```bash
npm install
```

## Configuración

Crea un archivo `.env` en la raíz:

```env
OPENROUTER_API_KEY=tu_api_key_aqui

# Opcional: lista de IDs :free separados por coma
PREFERRED_FREE_MODELS=

# Opcional: fuente de modelos por defecto (free | paid)
MODEL_SOURCE=free

# Opcional: whitelist de modelos pagos (IDs sin :free)
PAID_MODELS_WHITELIST=

# Opcional: lista de IDs :free a excluir manualmente
BLACKLIST_FREE_MODELS=

# Opcional: límite de modelos a evaluar (0 = sin límite)
MAX_MODELS=0

# Opcional: delay entre invocaciones (ms, default 5000)
INVOCATION_DELAY_MS=5000

# Opcional: timeout por solicitud a OpenRouter en milisegundos
REQUEST_TIMEOUT_MS=60000

# Opcional: auto-blacklist tras N errores 402 por modelo (0 desactiva)
AUTO_BLACKLIST_402_AFTER=2

# Opcional: proveedores/familias objetivo separados por coma
TARGET_PROVIDER_TAGS=openai,anthropic,gemini,deepseek,qwen,minimax
```

### Variables de entorno

- `OPENROUTER_API_KEY` (obligatoria): clave de API de OpenRouter.
- `PREFERRED_FREE_MODELS` (opcional): IDs exactos de modelos `:free` separados por coma.
  - Si se define, solo se evalúan esos modelos (si existen en ese momento).
- `MODEL_SOURCE` (opcional): fuente por defecto de modelos (`free` o `paid`).
- `PAID_MODELS_WHITELIST` (opcional): IDs de modelos pagos permitidos para usar cuando la fuente es `paid`.
- `BLACKLIST_FREE_MODELS` (opcional): IDs exactos de modelos `:free` a excluir del benchmark.
- `MAX_MODELS` (opcional): limita cuántos modelos evaluar.
- `INVOCATION_DELAY_MS` (opcional): delay entre invocaciones en milisegundos (por defecto `5000`).
- `REQUEST_TIMEOUT_MS` (opcional): timeout por request al endpoint de chat.
- `AUTO_BLACKLIST_402_AFTER` (opcional): cantidad de errores `402` tras la cual un modelo se agrega automáticamente a blacklist.
- `TARGET_PROVIDER_TAGS` (opcional): filtra por proveedor/familia.
  - Soporta el caso `gemini` (modelos de Google Gemini).

## Uso

### 1) Benchmark de consumo de tokens

```bash
npm run benchmark
```

También puedes ejecutar:

```bash
node index.js
```

Seleccionando fuente explícitamente por argumento:

```bash
node index.js --model-source=free
node index.js --model-source=paid
```

También se aceptan atajos:

```bash
node index.js --free
node index.js --paid
```

Con script npm para pagos:

```bash
npm run benchmark:paid
```

### 2) Listar modelos gratuitos disponibles

```bash
npm run list:free-models
```

O directamente:

```bash
node list-free-models.js
```

### 3) Listar modelos pagos ordenados por precio

```bash
npm run list:paid-models
```

O directamente:

```bash
node list-paid-models.js
```

Este listado ordena de menor a mayor precio estimado por millón de tokens (`$/1M`) usando el promedio entre input y output cuando ambos existen.
Además, guarda/reescribe automáticamente `paid-models.md` con la tabla completa.

## Flujo de benchmark

1. Carga prompts desde la carpeta `prompts/`.
2. Obtiene catálogo de modelos desde la API de OpenRouter.
3. Elige fuente según `--model-source` / `MODEL_SOURCE`:
  - `free`: usa `:free` y filtros (`TARGET_PROVIDER_TAGS`, `PREFERRED_FREE_MODELS`).
  - `paid`: usa `PAID_MODELS_WHITELIST`.
4. Aplica blacklist y límite (`BLACKLIST_FREE_MODELS`, `MAX_MODELS`).
5. Ejecuta llamadas con una pausa entre invocaciones.
6. Imprime tablas por modelo con comparación por idioma.
7. Sobrescribe el archivo `benchmark-results.md` con el resumen de la corrida.

## Estructura del proyecto

```text
.
├─ index.js
├─ list-free-models.js
├─ package.json
├─ .gitignore
├─ README.md
└─ prompts/
   ├─ en.md
   ├─ es.md
   └─ zh.md
```

## Notas

- Si falta `OPENROUTER_API_KEY`, los scripts fallan con error explícito.
- La disponibilidad de modelos `:free` cambia con el tiempo según OpenRouter.
- Los prompts se leen como Markdown en texto plano.
- Si un modelo devuelve errores definitivos de endpoint no disponible (por ejemplo, `No endpoints found`), se agrega automáticamente a `.model-blacklist.json`.
- Si un modelo acumula errores `402` repetidos, también puede entrar automáticamente en blacklist según `AUTO_BLACKLIST_402_AFTER`.
- Puedes limpiar esa blacklist borrando el archivo `.model-blacklist.json`.
- El reporte en Markdown se guarda en `benchmark-results.md` y se sobreescribe en cada ejecución completa.
