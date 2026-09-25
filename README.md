# CUADRA

Mini editor propio: junta clips cortos (≈4 s) en un vídeo vertical de 1080 para Instagram.

- **Historia** 1080×1920 (9:16, hasta 1 min) o **Publicación** 1080×1350 (4:5, hasta 3 min); lo que sobra se corta
- Duración por clip: 4 s, 8 s o **Ritmo** (BPM con tap tempo × 2/4/8 golpes) para que los cortes caigan a ritmo
- Transiciones (corte, fundido, negro, deslizar, zoom) y fundido de entrada y salida desde negro
- **Igualar tono** (No / Suave / Fuerte) y **Look** para todo el vídeo (Natural, Vivo, Cálido, Cine, Frío, B/N)
- Orden automático por **hora de grabación** (se lee de la caja `mvhd` del .mov/.mp4) y hora en cada miniatura
- Editor por clip en pestañas:
  - **Trozo**: frame exacto de inicio y velocidad (0,5× / 1× / 2×)
  - **Encuadre**: arrastrar, zoom, **zoom lento** (acercar/alejar, «aplicar a todos» alterna) y guías de IG
  - **Luz**: brillo, calidez y saturación, con «aplicar a todos»
  - **Tapar**: recuadros que **pixelan** (matrículas), con posición de inicio y final si se mueven
- **Hazlo tú**: analiza cada clip (nitidez, tembleque, exposición, movimiento) y monta el borrador: mejor trozo de
  cada clip, **vídeos largos partidos en sus mejores trozos** (reparto óptimo), orden por hora, zoom lento en planos quietos,
  y un **director** que elige look, transición e igualado de tono según luz, color y movimiento
- **IA en el móvil** (opcional, se descarga la primera vez y luego va sin internet):
  - **Matrículas automáticas** con seguimiento: YOLOv9-tiny de [open-image-models](https://github.com/ankandrew/open-image-models) (MIT) en `models/`, con onnxruntime-web
  - **Encuadre inteligente**: MediaPipe Object Detector (EfficientDet-Lite0) centra al protagonista en clips horizontales, con paneo si se mueve
- Duplicar clip, deshacer al quitar, reordenar arrastrando
- **Borradores**: lo que editas se guarda solo en el móvil (IndexedDB); «Guardar» le pone nombre y lo deja en la lista
- Exporta MP4 y se guarda o comparte desde el menú del iPhone

Es una PWA sin dependencias ni build: HTML + CSS + JS. Todo se procesa en el móvil
(canvas + MediaRecorder, en tiempo real) y los vídeos nunca salen del teléfono.

```
index.html      # pantalla principal, editor de clip y reproductor
css/styles.css
js/app.js       # lógica, editor y motor de composición/exportación
sw.js           # caché para uso sin conexión
manifest.json   # instalación como app
icons/
```

Al cambiar `css`/`js`, sube el `?v=N` en `index.html` y en `sw.js` (y el nombre de `CACHE`)
para que el iPhone no se quede con la versión antigua.

Probar en local: `python -m http.server 8792` y abrir http://localhost:8792
