// ============================================================
// Tribulars · Extractor Effi → Supabase
// Misma lógica que validamos en vivo: navega a las facturas con
// el rango de fechas por mes y lee el resumen (Total bruto, etc.).
// ============================================================
import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const {
  EFFI_URL = "https://effi.com.co/ingreso",
  EFFI_EMAIL,
  EFFI_PASSWORD,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,   // usar la service_role key (escribe en la tabla)
  CLIENTE_NIT = "901422372", // Bentley por defecto
  EXTRACTOR_SECRET,        // clave simple para proteger el endpoint
  PORT = 3000
} = process.env;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- helpers de parseo (idénticos a la lógica probada) ---
function num(s) {
  if (!s) return 0;
  const f = parseFloat(String(s).replace(/[^0-9.\-]/g, "").replace(/,/g, ""));
  // Effi muestra formato 1,234,567.89 (coma miles, punto decimal)
  const clean = String(s).replace(/[^0-9.,\-]/g, "").replace(/,/g, "");
  const v = parseFloat(clean);
  return isNaN(v) ? 0 : v;
}
function grab(text, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\$([\\d.,]+)");
  const m = text.match(re);
  return m ? m[1] : null;
}
function ultimoDiaMes(anio, mes) {
  return new Date(anio, mes, 0).getDate(); // mes 1..12
}

// new Date(str).toISOString() TIRA (RangeError) si str no es parseable —
// y como se llama dentro de un .map() sobre miles de filas, una sola fecha
// rara (formato distinto, celda compuesta, vacía) tumbaba el lote completo.
// Esta versión nunca lanza: null si no se pudo parsear.
function parsearFechaSegura(texto) {
  if (!texto) return null;
  // Formato compuesto confirmado en logs: "Real: 2026-06-19  Creación:
  // 2026-06-24 12:16:30" — aparece cuando la fecha real del movimiento
  // difiere de cuándo se registró en Effi. Se usa la fecha REAL (la del
  // movimiento en sí), no la de creación del registro.
  const real = texto.match(/Real:\s*([\d/-]+)/i);
  if (real) {
    const d = new Date(real[1]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Formato simple (fecha/hora directa, sin "Real:"/"Creación:").
  const d2 = new Date(texto);
  return isNaN(d2.getTime()) ? null : d2.toISOString();
}

// ============================================================
// TRAZABILIDAD DE DINERO (Tesorería) — requisitos de negocio, ver
// docs/effi-trazabilidad-dinero.sql en tribulars-app:
//  1. Dispara desde el mismo /extraer (ya lo hace, ver extraer() abajo).
//  2 y 4. Solo transacciones VIGENTES (nunca anuladas).
//  3. Solo estos medios de pago.
//
// Confirmado por captura 2026-07-27 — el combo "Medio de pago*" tiene UNA
// sola opción "Transferencia bancaria(BANCOL, ADDI, SIST, WOMP, DAVIVIENDA)"
// (no son 5 opciones separadas, era un error de interpretación inicial) más
// otra para "Bold" (aún no confirmado el texto exacto, se busca por
// substring "Bold"). Por eso el matching es por TEXTO PARCIAL, no exacto:
// así no importa el número de prefijo ("5 - ...") ni que Effi reordene la
// lista. "Vigencia de transacción" SÍ tiene texto confirmado y exacto:
// "Transacción vigente" / "Transacción anulada".
//
// ⚠️ Sigue siendo el widget de Effi sin probar en vivo: es un dropdown tipo
// select2 (con buscador). Si el log de Railway dice "no pude seleccionar",
// hay que ajustar esta lógica viendo el DOM real.
// ============================================================
const TRAZ_MEDIOS_PERMITIDOS = [
  { buscar: "Transferencia bancaria", guardar: "TRANSFERENCIA_BANCARIA" },
  { buscar: "Bold", guardar: "BOLD" } // TODO: confirmar texto exacto de esta opción (falta scroll en la captura)
];
const TRAZ_VIGENCIA_VALOR = "Transacción vigente"; // confirmado por captura 2026-07-27

// Confirmado en logs de Railway (2026-07-27): Effi usa el plugin Chosen.js
// — el <select> real existe con ID fijo pero queda oculto (display:none) y
// Chosen dibuja un widget encima. selectOption normal falla por "element is
// not visible". Fix: ir directo por ID + { force: true } para saltarse el
// chequeo de visibilidad (Playwright igual dispara change/input, que es lo
// que Chosen escucha para sincronizar su UI — y lo que el form realmente
// envía en "Aplicar filtros").
async function seleccionarChosen(page, selectId, subTexto) {
  const select = page.locator("#" + selectId);
  if (!(await select.count())) {
    console.warn(`[traz] no encontré #${selectId} en la página`);
    return false;
  }
  try {
    const valor = await select.evaluate((el, sub) => {
      const opt = Array.from(el.options).find((o) => o.textContent.includes(sub));
      return opt ? opt.value : null;
    }, subTexto);
    if (valor == null) {
      const opciones = await select.evaluate((el) => Array.from(el.options).map((o) => o.textContent.trim()));
      console.warn(`[traz] ninguna <option> de #${selectId} contiene "${subTexto}". Opciones disponibles: ${JSON.stringify(opciones)}`);
      return false;
    }
    await select.selectOption({ value: valor }, { force: true });
    return true;
  } catch (e) {
    console.warn(`[traz] selectOption forzado falló en #${selectId} ~ "${subTexto}": ${e.message}`);
    return false;
  }
}

async function aplicarFiltros(page) {
  // getByRole cubre <button>, <a role=button> Y <input type=submit/button
  // value="..."> (el texto en un <input> vive en el atributo value, no como
  // textContent — por eso locator('button,a').filter({hasText}) no lo veía).
  let btn = page.getByRole("button", { name: /aplicar filtros/i }).first();
  if (!(await btn.count())) {
    // Respaldo: filter({hasText}) no matchea <input> (su texto vive en
    // value, no en textContent) — buscar por el atributo value a mano.
    const inputs = page.locator('input[type="submit"], input[type="button"]');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const val = await inputs.nth(i).getAttribute("value").catch(() => null);
      if (val && /aplicar filtros/i.test(val)) { btn = inputs.nth(i); break; }
    }
  }
  await btn.click({ timeout: 10000 });
  await page.waitForTimeout(2000);
}

// Lee la tabla de resultados de Trazabilidad de dinero para el medio de
// pago ya filtrado. Lee encabezados dinámicamente (no asume orden fijo de
// columnas) por si Effi agrega/quita una columna.
async function leerTablaTrazabilidad(page) {
  const headers = await page.locator("table thead th").allTextContents();
  const norm = (s) => s.trim().toLowerCase();
  const idx = {
    fecha: headers.findIndex((h) => norm(h).includes("fecha")),
    id: headers.findIndex((h) => norm(h) === "id"),
    sucursal: headers.findIndex((h) => norm(h).includes("sucursal")),
    transaccion: headers.findIndex((h) => norm(h) === "transacción" || norm(h) === "transaccion"),
    detalles: headers.findIndex((h) => norm(h).includes("detalle")),
    efectivo: headers.findIndex((h) => norm(h).includes("efectivo")),
    banco: headers.findIndex((h) => norm(h).includes("banco")),
    observacion: headers.findIndex((h) => norm(h).includes("observaci")),
    responsable: headers.findIndex((h) => norm(h).includes("responsable"))
  };

  const filas = [];
  let pagina = 1;
  const TOPE_PAGINAS = 50; // salvaguarda anti-loop-infinito
  while (pagina <= TOPE_PAGINAS) {
    const rows = page.locator("table tbody tr");
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const tds = await rows.nth(i).locator("td").allTextContents();
      if (!tds.length) continue;
      const get = (k) => (idx[k] >= 0 && tds[idx[k]] != null ? tds[idx[k]].trim() : "");
      filas.push({
        effi_id: get("id"),
        fechaTexto: get("fecha"),
        sucursal_transaccion: get("sucursal"),
        transaccion: get("transaccion"),
        detalles: get("detalles"),
        efectivo: num(get("efectivo")),
        banco: num(get("banco")),
        observacion: get("observacion"),
        responsable: get("responsable")
      });
    }
    // Paginación: buscar botón "Siguiente" / ">" habilitado.
    const siguiente = page.locator("a, button").filter({ hasText: /siguiente|›|»/i }).first();
    if (!(await siguiente.count())) break;
    const disabled = await siguiente.evaluate((el) => el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true").catch(() => false);
    if (disabled) break;
    await siguiente.click({ timeout: 5000 }).catch(() => { pagina = TOPE_PAGINAS + 1; });
    // Recortado de 1200ms: con ~100+ páginas por medio de pago, cada ms
    // acá se multiplica y suma minutos a la petición completa.
    await page.waitForTimeout(600);
    pagina++;
  }
  return filas;
}

// Prepara filas crudas de una pasada (un medio de pago) al formato final
// de effi_trazabilidad_dinero, descartando las que no tengan effi_id o
// fecha parseable. Logging acotado: con miles de filas, un warn por fila
// puede pisar el límite de logs/seg de Railway (ya pasó una vez).
function prepararFilasTraz(filasCrudas, medioGuardar) {
  let fechasNoParseadas = 0;
  const listas = filasCrudas
    .filter((f) => f.effi_id) // sin ID no hay forma de deduplicar de forma segura
    .filter((f) => {
      const ok = parsearFechaSegura(f.fechaTexto) != null;
      if (!ok) {
        fechasNoParseadas++;
        if (fechasNoParseadas <= 10) console.warn(`[traz] fila descartada (fecha no parseable): id=${f.effi_id} fecha="${f.fechaTexto}"`);
      }
      return ok;
    })
    .map((f) => ({
      cliente_nit: CLIENTE_NIT,
      effi_id: f.effi_id,
      fecha: parsearFechaSegura(f.fechaTexto),
      sucursal_transaccion: f.sucursal_transaccion,
      transaccion: f.transaccion,
      detalles: f.detalles,
      medio_pago: medioGuardar,
      vigencia: "vigente", // por diseño: solo se filtró y trajo lo vigente
      efectivo: f.efectivo,
      banco: f.banco,
      observacion: f.observacion,
      responsable: f.responsable,
      fecha_sync: new Date().toISOString()
    }));
  if (fechasNoParseadas > 10) console.warn(`[traz] ... y ${fechasNoParseadas - 10} filas más descartadas por fecha no parseable (total: ${fechasNoParseadas})`);
  return listas;
}

// Guarda un lote de filas de trazabilidad en Supabase, partido en trozos
// chicos (baja el pico de memoria/payload; si un trozo falla, los demás
// igual se guardan). Dedupea por effi_id primero (Postgres no permite que
// un mismo upsert toque la misma fila dos veces).
async function guardarTrazEnLotes(filas, etiqueta) {
  if (!filas.length) return;
  const porId = new Map();
  filas.forEach((f) => porId.set(f.effi_id, f));
  const unicas = Array.from(porId.values());
  if (unicas.length !== filas.length) {
    console.warn(`[traz] ${etiqueta}: deduplicadas ${filas.length - unicas.length} filas repetidas por effi_id`);
  }
  const TAMANO_LOTE = 300;
  let guardadas = 0, lotesConError = 0;
  for (let i = 0; i < unicas.length; i += TAMANO_LOTE) {
    const lote = unicas.slice(i, i + TAMANO_LOTE);
    const { error } = await sb.from("effi_trazabilidad_dinero").upsert(lote, { onConflict: "cliente_nit,effi_id" });
    if (error) {
      lotesConError++;
      console.error(`[traz] ${etiqueta}: error guardando lote ${i}-${i + lote.length}:`, error);
    } else {
      guardadas += lote.length;
    }
  }
  console.log(`[traz] ${etiqueta}: guardado ${guardadas}/${unicas.length} filas` + (lotesConError ? ` (${lotesConError} lote(s) con error)` : ""));
}

// Trae Trazabilidad de dinero completa (todos los medios permitidos, solo
// vigentes) y GUARDA cada medio apenas termina de scrapearlo (no espera a
// tenerlo todo junto). No filtra por mes: Effi solo retiene una ventana
// reciente ("Solo se visualizan los registros desde..."), así que se pide
// todo lo que Effi quiera mostrar y el histórico se va acumulando en
// Supabase corrida tras corrida.
//
// Guardar por medio (no todo al final) es a propósito: si esta petición se
// corta a mitad de camino (timeout de plataforma, lo que parece estar
// pasando con lotes grandes en una sola petición), lo ya scrapeado no se
// pierde — queda guardado antes de intentar el siguiente medio.
// Diagnóstico único: lista todos los <select> de la página con su id/name
// y las primeras opciones. Para encontrar el id real de "Ingreso | Egreso"
// (nunca lo confirmamos — probablemente por eso los totales salen inflados,
// sumando egresos junto con ingresos) sin tener que adivinar a ciegas.
async function volcarSelectsDisponibles(page) {
  try {
    const info = await page.locator("select").evaluateAll((selects) =>
      selects.map((s) => ({
        id: s.id || null,
        name: s.name || null,
        opciones: Array.from(s.options).slice(0, 6).map((o) => o.textContent.trim())
      }))
    );
    console.log("[traz] selects disponibles en la página:", JSON.stringify(info));
  } catch (e) {
    console.warn("[traz] no pude volcar los selects de la página:", e.message);
  }
}

// TODO: confirmar el id real del filtro "Ingreso | Egreso" (ver volcarSelectsDisponibles
// en el log) y agregar el mismo tipo de filtro que vigencia_trans/medio_pago para
// quedarnos solo con "Ingreso" — hoy probablemente se están sumando también los egresos.
async function extraerTrazabilidadDinero(page) {
  const TRAZ_URL = "https://effi.com.co/app/trazabilidad_dinero"; // confirmado por logs 2026-07-27 (encontró #medio_pago y #vigencia_trans en esta ruta)
  let totalEncontradas = 0;
  let diagnosticoHecho = false;

  for (const { buscar, guardar } of TRAZ_MEDIOS_PERMITIDOS) {
    await page.goto(TRAZ_URL, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => {
      console.warn(`[traz] no pude navegar a ${TRAZ_URL}: ${e.message}`);
    });
    await page.waitForTimeout(1500);

    if (!diagnosticoHecho) {
      await volcarSelectsDisponibles(page);
      diagnosticoHecho = true;
    }

    const okVigencia = await seleccionarChosen(page, "vigencia_trans", TRAZ_VIGENCIA_VALOR);
    const okMedio = await seleccionarChosen(page, "medio_pago", buscar);
    if (!okVigencia || !okMedio) {
      console.warn(`[traz] filtros incompletos para medio~"${buscar}" (vigencia=${okVigencia}, medio=${okMedio}) — se omite esta pasada`);
      continue;
    }

    await aplicarFiltros(page);
    const filasCrudas = await leerTablaTrazabilidad(page);
    console.log(`[traz] medio=${guardar}: ${filasCrudas.length} movimientos scrapeados`);

    const filasListas = prepararFilasTraz(filasCrudas, guardar);
    await guardarTrazEnLotes(filasListas, guardar);
    totalEncontradas += filasListas.length;
  }

  return totalEncontradas;
}

// --- extrae un módulo (venta/compra) de un mes ---
async function leerResumen(page, tipo, anio, mes) {
  const dd = String(ultimoDiaMes(anio, mes)).padStart(2, "0");
  const mm = String(mes).padStart(2, "0");
  let url, etiquetaCount;
  if (tipo === "venta") {
    url = `https://effi.com.co/app/factura_v?desde=${anio}-${mm}-01%2000:00:00&hasta=${anio}-${mm}-${dd}%2023:59:59`;
    etiquetaCount = "facturas de venta encontradas";
  } else if (tipo === "compra") {
    url = `https://effi.com.co/app/factura_c?compra_desde=${anio}-${mm}-01&compra_hasta=${anio}-${mm}-${dd}`;
    etiquetaCount = "facturas de compra encontradas";
  } else if (tipo === "nc_venta") {
    // Notas crédito de venta: restan ventas e IVA generado (mismo resumen y filtro desde/hasta)
    url = `https://effi.com.co/app/nota_credito_v?desde=${anio}-${mm}-01%2000:00:00&hasta=${anio}-${mm}-${dd}%2023:59:59`;
    etiquetaCount = "notas crédito de venta encontradas";
  }
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);
  const t = await page.evaluate(() => document.body.innerText);
  const fm = t.match(new RegExp("(\\d+)\\s+" + etiquetaCount));
  return {
    cliente_nit: CLIENTE_NIT,
    anio, mes, tipo,
    bruto: num(grab(t, "Total bruto:")),
    descuentos: num(grab(t, "Descuentos:")),
    iva: num(grab(t, "Impuestos:")),
    retenciones: num(grab(t, "Retenciones:")),
    neto: num(grab(t, "Total neto:")),
    facturas: fm ? parseInt(fm[1], 10) : 0,
    actualizado: new Date().toISOString()
  };
}

// Login en Effi — compartido por extraer() y extraerYGuardarTrazabilidad().
// NOTA: confirmar los selectores reales del formulario de ingreso de Effi.
async function login(page) {
  await page.goto(EFFI_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.fill('input[type="email"], input[name="email"], #email', EFFI_EMAIL);
  await page.fill('input[type="password"], input[name="password"], #password', EFFI_PASSWORD);
  // Enviar el formulario: Enter suele bastar en casi cualquier login
  await page.press('input[type="password"], input[name="password"], #password', "Enter");
  await page.waitForTimeout(3000);
  // Respaldo: si seguimos en la página de ingreso, buscar el botón por texto
  if (page.url().includes("ingreso") || page.url().includes("login")) {
    const btn = page.locator('button, input[type=submit], a.btn, a').filter({ hasText: /ingres|entrar|inicia|acceder/i }).first();
    if (await btn.count()) { await btn.click({ timeout: 10000 }).catch(() => {}); }
  }
  // Esperar a que cargue el panel (sale de /ingreso)
  await page.waitForTimeout(6000);
}

// --- proceso ventas/compras: login + recorrer meses + guardar ---
// Trazabilidad de dinero corre SEPARADA (ver extraerYGuardarTrazabilidad):
// hacerlo todo en una sola petición HTTP terminaba pasándose de varios
// minutos y la plataforma mataba el contenedor a mitad de camino, sin
// dejar ni un error en el log. Partirlo en dos peticiones más cortas evita
// eso — el botón "Actualizar Effi" dispara ambas, sigue siendo un solo clic.
async function extraer({ anio, hastaMes }) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const filas = [];
  try {
    await login(page);
    for (let mes = 1; mes <= hastaMes; mes++) {
      for (const tipo of ["venta", "compra", "nc_venta"]) {
        const fila = await leerResumen(page, tipo, anio, mes);
        filas.push(fila);
      }
    }
  } finally {
    await browser.close();
  }

  const { error } = await sb
    .from("effi_resumen")
    .upsert(filas, { onConflict: "cliente_nit,anio,mes,tipo" });
  if (error) throw error;

  return { filas };
}

// --- proceso trazabilidad de dinero: login propio + guarda por medio ---
async function extraerYGuardarTrazabilidad() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  let total = 0;
  try {
    await login(page);
    total = await extraerTrazabilidadDinero(page); // ya guarda incrementalmente por medio
  } finally {
    await browser.close();
  }
  return total;
}

// --- servidor con el endpoint que dispara el botón ---
const app = express();
app.use(express.json());

// CORS: permite que el botón "Actualizar Effi" (Netlify) llame a este servicio
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => res.send("Extractor Effi activo"));

app.post("/extraer", async (req, res) => {
  // NOTA: candado desactivado temporalmente para pruebas. Reactivar luego.
  const anio = req.body?.anio || new Date().getFullYear();
  const hastaMes = req.body?.hastaMes || (new Date().getMonth() + 1);
  try {
    const { filas } = await extraer({ anio, hastaMes });
    res.json({ ok: true, registros: filas.length, filas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Trazabilidad de dinero — endpoint SEPARADO de /extraer a propósito (ver
// nota en extraer()): el botón "Actualizar Effi" del frontend llama a los
// dos, uno tras otro, pero cada petición HTTP se mantiene corta por sí sola.
app.post("/extraer-trazabilidad", async (_req, res) => {
  try {
    const registrosTraz = await extraerYGuardarTrazabilidad();
    res.json({ ok: true, registrosTraz });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Extractor Effi escuchando en :" + PORT));
