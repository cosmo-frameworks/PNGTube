# PNGTuber - Avatar para OBS

Avatar animado estilo PNGTuber que reacciona a tu micrófono. Panel de control separado del overlay.

https://github.com/user-attachments/assets/7b31229c-8d52-40de-8cfe-0a673f664760

## Setup rápido

> [!WARNING]
> Es necesario tener node instaldo para ejecutar los comando

```bash
npm install
npm start
```

Tambien puede compilar el .js a .exe y ahorrarte tener que ejecutarlo por consola, para ello simplemente ejecuta lo siguiente

```bash
npm install
npm run build
```

## Configurar OBS

1. Añade fuente → **Navegador (Browser Source)**
2. Desmarca "Archivo local"
3. URL: `http://localhost:3377/overlay`
4. Tamaño: `800 x 800` (o el que prefieras)

## Panel de Control

Abre **http://localhost:3377/panel** en Chrome para:

- Subir imágenes (idle + hablando)
- Seleccionar y probar el micrófono
- Ajustar sensibilidad en tiempo real
- Configurar animaciones
- Cambiar atajo de teclado
- Ver preview en vivo

El panel captura tu micrófono desde Chrome y envía los niveles de audio al overlay en OBS por WebSocket.

## Tips

- Usa PNGs con **fondo transparente**
- Si parpadea mucho, sube la sensibilidad o el retardo
- Las imágenes se guardan en `/public/images/`
- La config se guarda en `config.json`
- Puerto por defecto: 3377 (cambiar con `PORT=xxxx npm start`)
