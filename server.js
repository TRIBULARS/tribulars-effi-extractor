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

// ============================================================
// TRAZABILIDAD DE DINERO (Tesorería) — requisitos de negocio, ver
// docs/effi-trazabilidad-dinero.sql en tribulars-app:
//  1. Dispara desde el mismo /extraer (ya lo hace, ver extraer() abajo).
//  2 y 4. Solo transacciones VIGENTES (nunca anuladas).
//  3. Solo estos medios de pago.
//
// ⚠️ TRAZ_MEDIOS_PERMITIDOS y TRAZ_VIGENCIA_VALOR son un PRIMER INTENTO —
// el texto EXACTO de las opciones del combo "Medio de pago*" y
// "Vigencia de transacción" en Effi todavía no está confirmado (falta
// captura de pantalla de esos dos desplegables). Si al correr esto en
// Railway el log dice "opción no encontrada", hay que ajustar estas listas
// con el texto real y redeployar. NO asumir que esto funciona sin probarlo.
// ============================================================
const TRAZ_MEDIOS_PERMITIDOS = ["BANCOLOMBIA", "ADDI", "SISTECREDITO", "WOMPI", "DAVIVIENDA", "BOLD"]; // TODO: confirmar texto exacto
const TRAZ_VIGENCIA_VALOR = "Vigente"; // TODO: confirmar texto exacto

// Busca un <select> nativo cerca de un texto de etiqueta visible y le
// selecciona una opción por texto. Si Effi usa un widget custom (no un
// <select> nativo) esto va a fallar — hay variante custom más abajo.
async function seleccionarPorEtiqueta(page, etiqueta, opcionTexto) {
  const label = page.locator("text=" + etiqueta).first();
  const select = label.locator("xpath=following::select[1]");
  if (await select.count()) {
    try {
      await select.selectOption({ label: opcionTexto });
      return true;
    } catch (e) {
      console.warn(`[traz] no pude seleccionar "${opcionTexto}" en <select> cerca de "${etiqueta}": ${e.message}`);
    }
  }
  // Fallback: dropdown custom tipo select2/choices.js — click para abrir,
  // click en la opción por texto visible.
  try {
    const widget = label.locator("xpath=following::*[contains(@class,'select') or contains(@class,'dropdown')][1]").first();
    await widget.click({ timeout: 3000 });
    await page.locator("text=" + opcionTexto).first().click({ timeout: 3000 });
    return true;
  } catch (e) {
    console.warn(`[traz] fallback custom-dropdown también falló para "${etiqueta}" = "${opcionTexto}": ${e.message}`);
    return false;
  }
}

async function aplicarFiltros(page) {
  const btn = page.locator("button, a").filter({ hasText: /aplicar filtros/i }).first();
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
  const TRAZ_URL = "https://effi.com.co/app/trazabilidad_dinero"; // TODO: confirmar ruta real (se infiere del nombre del menú)
  const filasTodas = [];

  for (const medio of TRAZ_MEDIOS_PERMITIDOS) {
    await page.goto(TRAZ_URL, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => {
      console.warn(`[traz] no pude navegar a ${TRAZ_URL}: ${e.message}`);
    });
    await page.waitForTimeout(1500);

    const okVigencia = await seleccionarPorEtiqueta(page, "Vigencia de transacción", TRAZ_VIGENCIA_VALOR);
    const okMedio = await seleccionarPorEtiqueta(page, "Medio de pago", medio);
    if (!okVigencia || !okMedio) {
      console.warn(`[traz] filtros incompletos para medio="${medio}" (vigencia=${okVigencia}, medio=${okMedio}) — se omite esta pasada`);
      continue;
    }

    await aplicarFiltros(page);
    const filas = await leerTablaTrazabilidad(page);
    console.log(`[traz] medio=${medio}: ${filas.length} movimientos`);
    filasTodas.push(...filas.map((f) => ({ ...f, medio_pago: medio })));
  }

  return filasTodas
    .filter((f) => f.effi_id) // sin ID no hay forma de deduplicar de forma segura
    .map((f) => ({
      cliente_nit: CLIENTE_NIT,
      effi_id: f.effi_id,
      fecha: f.fechaTexto ? new Date(f.fechaTexto).toISOString() : null,
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
    }))
    .filter((f) => f.fecha); // descarta filas cuya fecha no se pudo parsear
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
