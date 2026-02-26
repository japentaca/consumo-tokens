# consumo-tokens

Script en Node.js para medir y comparar consumo de tokens por idioma (EN, ES, ZH) usando:

- modelos gratuitos disponibles (`:free`), o
- una whitelist de modelos pagos definida en `.env`.

Ofrece una **interfaz web** para ejecutar benchmarks visualmente y consultar la lista de modelos.

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

1. Copia `.env.example` a `.env` y añade tu clave de OpenRouter
2. Ejecuta `npm start`
3. Navega a `http://localhost:3050`
4. Selecciona la fuente de modelos (gratuitos o pagos)
5. Ejecuta las pruebas visualizando el progreso en tiempo real

## Estructura del proyecto

```text
.
├─ index.js
├─ benchmark-runner.js
├─ database.js
├─ package.json
├─ .gitignore
├─ README.md
├─ public/
│  └─ ... (archivos de frontend)
└─ prompts/
   ├─ en.md
   ├─ es.md
   └─ zh.md
```

## Notas

- Si falta `OPENROUTER_API_KEY`, los scripts fallan con error explícito.
- La disponibilidad de modelos `:free` cambia con el tiempo según OpenRouter.
- Los prompts se leen desde la base de datos o desde la carpeta `prompts/`.
- Todos los resultados y persistencia de pruebas se gestionan exclusivamente en la base de datos SQLite y se exponen mediante la interfaz web.
