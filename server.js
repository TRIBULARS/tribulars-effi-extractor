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

// --- extrae un módulo (venta/compra) de un mes ---
async function leerResumen(page, tipo, anio, mes) {
  const dd = String(ultimoDiaMes(anio, mes)).padStart(2, "0");
  const mm = String(mes).padStart(2, "0");
  let url;
  if (tipo === "venta") {
    url = `https://effi.com.co/app/factura_v?desde=${anio}-${mm}-01%2000:00:00&hasta=${anio}-${mm}-${dd}%2023:59:59`;
  } else {
    url = `https://effi.com.co/app/factura_c?compra_desde=${anio}-${mm}-01&compra_hasta=${anio}-${mm}-${dd}`;
  }
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);
  const t = await page.evaluate(() => document.body.innerText);
  const etiquetaCount = tipo === "venta" ? "facturas de venta encontradas" : "facturas de compra encontradas";
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
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForTimeout(5000);

    // 2) Recorrer cada mes (ventas y compras)
    for (let mes = 1; mes <= hastaMes; mes++) {
      for (const tipo of ["venta", "compra"]) {
        const fila = await leerResumen(page, tipo, anio, mes);
        filas.push(fila);
      }
    }
  } finally {
    await browser.close();
  }

  // 3) Guardar en Supabase (upsert: no duplica, actualiza)
  const { error } = await sb
    .from("effi_resumen")
    .upsert(filas, { onConflict: "cliente_nit,anio,mes,tipo" });
  if (error) throw error;
  return filas;
}

// --- servidor con el endpoint que dispara el botón ---
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("Extractor Effi activo"));

app.post("/extraer", async (req, res) => {
  // NOTA: candado desactivado temporalmente para pruebas. Reactivar luego.
  const anio = req.body?.anio || new Date().getFullYear();
  const hastaMes = req.body?.hastaMes || (new Date().getMonth() + 1);
  try {
    const filas = await extraer({ anio, hastaMes });
    res.json({ ok: true, registros: filas.length, filas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log("Extractor Effi escuchando en :" + PORT));
