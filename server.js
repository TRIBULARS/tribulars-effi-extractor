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
  const d = new Date(texto);
  return isNaN(d.getTime()) ? null : d.toISOString();
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
    await page.waitForTimeout(1200);
    pagina++;
  }
  return filas;
}

// Trae Trazabilidad de dinero completa (todos los medios permitidos,
// solo vigentes). No filtra por mes: Effi solo retiene una ventana
// reciente ("Solo se visualizan los registros desde..."), así que se pide
// todo lo que Effi quiera mostrar y el histórico se va acumulando en
// Supabase corrida tras corrida (upsert, nunca se pierde lo ya guardado).
async function extraerTrazabilidadDinero(page) {
  const TRAZ_URL = "https://effi.com.co/app/trazabilidad_dinero"; // confirmado por logs 2026-07-27 (encontró #medio_pago y #vigencia_trans en esta ruta)
  const filasTodas = [];

  for (const { buscar, guardar } of TRAZ_MEDIOS_PERMITIDOS) {
    await page.goto(TRAZ_URL, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => {
      console.warn(`[traz] no pude navegar a ${TRAZ_URL}: ${e.message}`);
    });
    await page.waitForTimeout(1500);

    const okVigencia = await seleccionarChosen(page, "vigencia_trans", TRAZ_VIGENCIA_VALOR);
    const okMedio = await seleccionarChosen(page, "medio_pago", buscar);
    if (!okVigencia || !okMedio) {
      console.warn(`[traz] filtros incompletos para medio~"${buscar}" (vigencia=${okVigencia}, medio=${okMedio}) — se omite esta pasada`);
      continue;
    }

    await aplicarFiltros(page);
    const filas = await leerTablaTrazabilidad(page);
    console.log(`[traz] medio=${guardar}: ${filas.length} movimientos`);
    filasTodas.push(...filas.map((f) => ({ ...f, medio_pago: guardar })));
  }

  return filasTodas
    .filter((f) => f.effi_id) // sin ID no hay forma de deduplicar de forma segura
    .filter((f) => {
      const ok = parsearFechaSegura(f.fechaTexto) != null;
      if (!ok) console.warn(`[traz] fila descartada (fecha no parseable): id=${f.effi_id} fecha="${f.fechaTexto}"`);
      return ok;
    })
    .map((f) => ({
      cliente_nit: CLIENTE_NIT,
      effi_id: f.effi_id,
      fecha: parsearFechaSegura(f.fechaTexto),
      sucursal_transaccion: f.sucursal_transaccion,
      transaccion: f.transaccion,
      detalles: f.detalles,
      medio_pago: f.medio_pago,
      vigencia: "vigente", // por diseño: solo se filtró y trajo lo vigente
      efectivo: f.efectivo,
      banco: f.banco,
      observacion: f.observacion,
      responsable: f.responsable,
      fecha_sync: new Date().toISOString()
    }));
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

// --- proceso completo: login + recorrer meses + guardar ---
async function extraer({ anio, hastaMes }) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const filas = [];
  try {
    // 1) Login en Effi
    // NOTA: confirmar los selectores reales del formulario de ingreso de Effi.
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

    // 2) Recorrer cada mes (ventas, compras y notas crédito de venta)
    for (let mes = 1; mes <= hastaMes; mes++) {
      for (const tipo of ["venta", "compra", "nc_venta"]) {
        const fila = await leerResumen(page, tipo, anio, mes);
        filas.push(fila);
      }
    }

    // 2b) Trazabilidad de dinero (Tesorería) — misma sesión, mismo botón.
    var filasTraz = [];
    try {
      filasTraz = await extraerTrazabilidadDinero(page);
    } catch (e) {
      console.error("[traz] error extrayendo trazabilidad de dinero (no interrumpe el resto):", e);
    }
  } finally {
    await browser.close();
  }

  // 3) Guardar en Supabase (upsert: no duplica, actualiza)
  const { error } = await sb
    .from("effi_resumen")
    .upsert(filas, { onConflict: "cliente_nit,anio,mes,tipo" });
  if (error) throw error;

  if (filasTraz.length) {
    const { error: errorTraz } = await sb
      .from("effi_trazabilidad_dinero")
      .upsert(filasTraz, { onConflict: "cliente_nit,effi_id" });
    if (errorTraz) console.error("[traz] error guardando en Supabase:", errorTraz);
  }

  return { filas, filasTraz };
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
    const { filas, filasTraz } = await extraer({ anio, hastaMes });
    res.json({ ok: true, registros: filas.length, filas, registrosTraz: filasTraz.length, filasTraz });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Extractor Effi escuchando en :" + PORT));
