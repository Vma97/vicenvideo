# CUADRA

Mini editor propio: junta clips cortos (≈4 s) en un vídeo vertical de 1080 para Instagram.

- **Historia** 1080×1920 (9:16) o **Publicación** 1080×1350 (4:5)
- Duración por clip 4 u 8 s; máximo 1 min en historia y 3 min en publicación (lo que sobra se corta), transición (corte, fundido, negro, deslizar, zoom)
- Por clip: frame exacto de inicio, encuadre arrastrando y zoom
- Igualar tono (No / Suave / Fuerte): mide luz y color de cada clip y los acerca a un tono común (WebGL)
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
