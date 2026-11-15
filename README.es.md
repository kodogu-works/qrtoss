# qrtoss

[English](README.md) · [日本語](README.ja.md)

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
