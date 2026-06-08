# Extractor Effi → Supabase (Tribulars)

Servicio que inicia sesión en Effi, recorre ventas y compras mes a mes
(con la misma lógica ya validada) y guarda los resúmenes en Supabase.
El botón "Actualizar Effi" de la app web le dispara la orden.

## 1. Crear la tabla en Supabase
Abre Supabase → SQL Editor → pega `01-tabla-supabase.sql` → Run.

## 2. Subir a GitHub
Crea un repo nuevo (ej. `tribulars-effi-extractor`) con estos archivos
y haz push. (NO subas claves; van en variables de entorno).

## 3. Desplegar en Railway
- New Project → Deploy from GitHub repo → elige el repo.
- En Variables, agrega:
  - `EFFI_EMAIL`         = correo de Effi del cliente
  - `EFFI_PASSWORD`      = contraseña de Effi
  - `SUPABASE_URL`       = https://ditzlstdtgukvrpjxebi.supabase.co
  - `SUPABASE_SERVICE_KEY` = la **service_role** key de Supabase (Settings → API)
  - `CLIENTE_NIT`        = 901422372  (Bentley)
  - `EXTRACTOR_SECRET`   = una palabra secreta tuya (la usa el botón)
- Railway instala Chromium solo (postinstall). El primer deploy tarda un poco.

## 4. Probar
`POST https://<tu-servicio>.up.railway.app/extraer`
con header `x-secret: <EXTRACTOR_SECRET>` y body `{ "anio": 2026, "hastaMes": 6 }`.
Debe responder `{ ok: true, registros: 12, ... }` y llenar la tabla.

## ⚠️ Notas honestas
- **Login**: los selectores del formulario de Effi (`server.js`, sección Login)
  son una primera aproximación. Hay que confirmarlos contra el formulario real
  y ajustarlos. Esta parte requiere una prueba real (no se puede validar a ciegas).
- Si Effi muestra verificación "no soy un robot" en el login, el extractor
  automático puede trabarse ahí; tocaría revisarlo.
- Un servicio = un cliente Effi (un juego de credenciales). Para varios clientes
  con Effi, se parametriza por credenciales/NIT.
