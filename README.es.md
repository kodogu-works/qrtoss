<h1>
  <img src="docs/assets/qrtoss-logo.svg#gh-light-mode-only" alt="qrtoss" width="216" height="48">
  <img src="docs/assets/qrtoss-logo-dark.svg#gh-dark-mode-only" alt="qrtoss" width="216" height="48">
</h1>

[English](README.md) · [日本語](README.ja.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Go](https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Author](https://img.shields.io/badge/author-Synge%20Todo-blue)](https://github.com/wistaria)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)

Transfiere el contenido de un código QR desde el teléfono a otro navegador o a un terminal. Sin cuenta, aplicación instalada ni conexión a la misma red Wi-Fi. Escanea el QR de conexión con la cámara del teléfono, abre la página de envío, escanea el QR deseado, revisa el texto y confirma el envío.

El navegador receptor puede mostrar el texto o abrir direcciones HTTP(S) en la misma pestaña. El cliente de línea de comandos recibe **un solo elemento**, lo escribe en stdout y finaliza; el QR de conexión y los mensajes se muestran en stderr. La interfaz está disponible en inglés, japonés y español.

## Desarrollo local

Requisitos: Node.js 26, npm y Go 1.24 o posterior para compilar la CLI.

```sh
npm ci
npm run dev
```

Abre http://127.0.0.1:8080 para probar dos navegadores en el mismo ordenador. Para usar la cámara del teléfono necesitas un dominio HTTPS accesible con un certificado de confianza. Reinicia el comando después de cambiar el frontend.

## Alojamiento propio

Con un dominio y los puertos 80/443 disponibles, instala Docker Engine y Compose:

```sh
cp .env.example .env
# Configura PUBLIC_ORIGIN con tu origen HTTPS real, sin barra final.
docker compose up -d --build
```

No se necesita base de datos. Solo el proxy Caddy expone puertos públicos y conserva los certificados TLS. El proceso de la aplicación mantiene las conexiones en memoria. Consulta [las instrucciones de operación](docs/self-hosting.md).

Para publicar la versión de navegador bajo `/qrtoss/` en un sitio existente:

```sh
QRTOSS_BASE_PATH=/qrtoss/ npm run build
```

Mantén `PUBLIC_ORIGIN` como origen sin ruta, por ejemplo `https://myserver.example`. Apache debe quitar `/qrtoss` al reenviar HTTP y WebSocket a la aplicación. Consulta la [configuración de Apache para una subruta](docs/self-hosting.md#browser-deployment-under-an-apache-subpath). La ruta se fija al compilar y su valor predeterminado es `/`. La CLI y la configuración incluida de Docker Compose/Caddy siguen usando la raíz del origen.

## Alojamiento en Cloudflare

El servidor también funciona con Cloudflare Workers y Durable Objects, usando el mismo protocolo de navegador y CLI. Elige un dominio personalizado o una URL de `workers.dev` y configura el `PUBLIC_ORIGIN` correspondiente en `wrangler.jsonc`, ejecuta `npm run test:cloudflare` y publica con `npm run deploy:cloudflare`. Para workerd local, usa `npm run dev:cloudflare`. Consulta [la configuración, privacidad y operación en Cloudflare](docs/self-hosting.md#cloudflare-workers-and-durable-objects).

## Cliente de línea de comandos

```sh
cd cli
go build -trimpath -o qrtoss ./cmd/qrtoss
./qrtoss --server https://qr.your-domain.example > received.txt
./qrtoss --server https://qr.your-domain.example --jsonl > received.jsonl
./qrtoss --help
```

El origen de ejemplo no es un servicio público en funcionamiento. Indica tu servidor con `--server` o `QRTOSS_SERVER`. Usa `--jsonl` para textos con saltos de línea o caracteres de control. `--timeout 120` limita la espera del mensaje a 120 segundos; no limita una escritura lenta a stdout. No compartas el QR ni la URL de conexión. La CLI nunca abre ni ejecuta el contenido recibido.

## Verificación y licencia

```sh
npm run typecheck
npm run check:i18n
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
```

Para la CLI: `go test -race ./...` y `go vet ./...` desde `cli/`. Consulta [el estado de validación](docs/validation.md). Las pruebas automatizadas no sustituyen las pruebas en teléfonos reales ni una auditoría externa, que todavía no se ha realizado.

Los clientes cifran los mensajes de extremo a extremo mediante HKDF-SHA256 y AES-256-GCM. El servidor retransmite el texto cifrado sin conservar un historial ni una cola fuera de línea. La seguridad también depende de los dispositivos y del código servido por el proveedor. Consulta [SECURITY.md](SECURITY.md).

Licencia [MIT](LICENSE.md). Copyright © 2026 Synge Todo. Las dependencias conservan sus licencias: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
