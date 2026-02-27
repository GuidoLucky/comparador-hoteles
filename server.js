const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ─── CREDENCIALES (van como variables de entorno en Railway) ───
const TUCANO_USER = process.env.TUCANO_USER;
const TUCANO_PASS = process.env.TUCANO_PASS;
const TRAVELGEA_USER = process.env.TRAVELGEA_USER;
const TRAVELGEA_PASS = process.env.TRAVELGEA_PASS;

// ─── RUTA PRINCIPAL ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── ENDPOINT DE BÚSQUEDA ───
app.post('/buscar', async (req, res) => {
  const { destino, entrada, noches, adultos } = req.body;

  if (!destino || !entrada || !noches || !adultos) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  try {
    // Ejecutar ambas búsquedas en paralelo
    const [resultadosTucano, resultadosTravelgea] = await Promise.allSettled([
      buscarTucano(destino, entrada, parseInt(noches), parseInt(adultos)),
      buscarTravelgea(destino, entrada, parseInt(noches), parseInt(adultos))
    ]);

    const tucano = resultadosTucano.status === 'fulfilled' ? resultadosTucano.value : [];
    const travelgea = resultadosTravelgea.status === 'fulfilled' ? resultadosTravelgea.value : [];

    // Combinar y normalizar resultados
    const resultados = combinarResultados(tucano, travelgea);

    res.json({ ok: true, resultados });
  } catch (err) {
    console.error('Error en búsqueda:', err);
    res.status(500).json({ error: 'Error al consultar proveedores', detalle: err.message });
  }
});

// ─── BOT TUCANO ───
async function buscarTucano(destino, entrada, noches, adultos) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('[Tucano] Iniciando login...');

    // Login en tucanotours.com.ar
    await page.goto('https://www.tucanotours.com.ar/index.php', { waitUntil: 'networkidle' });
    await page.fill('input[name="usuario"]', TUCANO_USER);
    await page.fill('input[name="password"]', TUCANO_PASS);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForTimeout(2000);

    // Ir al portal de hoteles
    console.log('[Tucano] Yendo a PriceNavigator...');
    await page.goto('https://tucanotours.app.pricenavigator.net/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // Hacer click en Hoteles
    await page.click('text=Hoteles');
    await page.waitForTimeout(1000);

    // Completar búsqueda
    await page.fill('input[placeholder*="ciudad"], input[placeholder*="hotel"], input[placeholder*="interés"]', destino);
    await page.waitForTimeout(1000);

    // Seleccionar primera sugerencia
    const sugerencia = page.locator('.autocomplete-item, .suggestion, [class*="suggestion"], [class*="autocomplete"]').first();
    if (await sugerencia.isVisible()) {
      await sugerencia.click();
      await page.waitForTimeout(500);
    }

    // Fecha de entrada
    const fechaFormateada = formatearFechaTucano(entrada);
    await page.fill('input[placeholder="Entrada"], input[name*="entrada"], input[name*="checkin"]', fechaFormateada);
    await page.waitForTimeout(300);

    // Noches
    await page.fill('input[placeholder="Noches"], input[name*="noches"]', noches.toString());
    await page.waitForTimeout(300);

    // Adultos
    const inputAdultos = page.locator('input').filter({ hasText: '' }).nth(3);
    await page.fill('input[value="2"]', adultos.toString()).catch(() => {});

    // Buscar
    await page.click('button:has-text("Buscar"), .btn-buscar');
    await page.waitForTimeout(4000);

    // Extraer resultados
    console.log('[Tucano] Extrayendo resultados...');
    const resultados = await extraerResultadosTucano(page);

    await browser.close();
    return resultados;

  } catch (err) {
    console.error('[Tucano] Error:', err.message);
    await browser.close();
    return [];
  }
}

async function extraerResultadosTucano(page) {
  return await page.evaluate(() => {
    const hoteles = [];

    // Buscar cards de hoteles
    const cards = document.querySelectorAll('[class*="hotel"], [class*="property"], [class*="accommodation"]');

    cards.forEach(card => {
      const nombre = card.querySelector('[class*="name"], h2, h3')?.textContent?.trim();
      const estrellas = card.querySelectorAll('[class*="star"]')?.length || 5;

      const habitaciones = [];
      const tarifas = card.querySelectorAll('[class*="tarif"], [class*="room"], [class*="hab"]');

      tarifas.forEach(tarifa => {
        const nombre_hab = tarifa.querySelector('[class*="name"], [class*="type"]')?.textContent?.trim();
        const regimen = tarifa.querySelector('[class*="regime"], [class*="board"]')?.textContent?.trim();
        const precioEl = tarifa.querySelector('[class*="price"], [class*="precio"]');
        const precioText = precioEl?.textContent?.trim() || '';
        const precio = parseFloat(precioText.replace(/[^0-9.,]/g, '').replace(',', '.'));

        if (nombre_hab && !isNaN(precio)) {
          habitaciones.push({
            nombre: nombre_hab,
            regimen: regimen || 'Todo incluido',
            precioTotal: precio,
            reembolsable: tarifa.textContent.includes('eembolsable') || tarifa.textContent.includes('efundable')
          });
        }
      });

      // Si no encontró tarifas por selector, buscar precios sueltos
      if (habitaciones.length === 0) {
        const precioGeneral = card.querySelector('[class*="price"], [class*="precio"], .amount');
        const precioText = precioGeneral?.textContent?.trim() || '';
        const precio = parseFloat(precioText.replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (!isNaN(precio) && precio > 0) {
          habitaciones.push({
            nombre: 'Habitación disponible',
            regimen: 'Consultar',
            precioTotal: precio,
            reembolsable: false
          });
        }
      }

      if (nombre && habitaciones.length > 0) {
        hoteles.push({ hotel: nombre, estrellas, habitaciones });
      }
    });

    return hoteles;
  });
}

// ─── BOT TRAVELGEA ───
async function buscarTravelgea(destino, entrada, noches, adultos) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('[Travelgea] Iniciando login...');

    // Login en intranet
    await page.goto('https://intranet.grupogea.la/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Completar login (React app)
    await page.fill('input[type="email"], input[name="email"], input[name="usuario"], input[placeholder*="mail"], input[placeholder*="usuario"]', TRAVELGEA_USER);
    await page.fill('input[type="password"]', TRAVELGEA_PASS);
    await page.click('button[type="submit"], button:has-text("Ingresar"), button:has-text("Login")');
    await page.waitForTimeout(3000);

    // Ir al portal de hoteles
    console.log('[Travelgea] Yendo al portal...');
    await page.goto('https://online.travelgea.com.ar/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Completar búsqueda
    await page.fill('input[placeholder*="Destino"], input[placeholder*="hotel"], input[name*="destino"]', destino);
    await page.waitForTimeout(1000);

    // Seleccionar sugerencia
    const sugerencia = page.locator('[class*="suggestion"], [class*="autocomplete"], [class*="dropdown"] li').first();
    if (await sugerencia.isVisible({ timeout: 2000 })) {
      await sugerencia.click();
      await page.waitForTimeout(500);
    }

    // Fecha llegada
    const fechaFormateada = formatearFechaTravelgea(entrada);
    await page.fill('input[placeholder*="Llegada"], input[name*="llegada"], input[name*="checkin"]', fechaFormateada);
    await page.waitForTimeout(300);

    // Noches - es un select en Travelgea
    await page.selectOption('select[name*="noches"], select:near(:text("Noches"))', noches.toString()).catch(async () => {
      await page.fill('input[name*="noches"]', noches.toString());
    });

    // Adultos
    await page.selectOption('select[name*="adultos"], select:near(:text("Adultos"))', adultos.toString()).catch(async () => {
      await page.fill('input[name*="adultos"]', adultos.toString());
    });

    // País Argentina
    await page.selectOption('select[name*="pais"], select:near(:text("País"))', 'Argentina').catch(() => {});

    // Buscar
    await page.click('button:has-text("Buscar"), input[type="submit"]');
    await page.waitForTimeout(5000);

    // Extraer resultados
    console.log('[Travelgea] Extrayendo resultados...');
    const resultados = await extraerResultadosTravelgea(page);

    await browser.close();
    return resultados;

  } catch (err) {
    console.error('[Travelgea] Error:', err.message);
    await browser.close();
    return [];
  }
}

async function extraerResultadosTravelgea(page) {
  return await page.evaluate(() => {
    const hoteles = [];

    const cards = document.querySelectorAll('[class*="hotel"], [class*="property"], [class*="item"]');

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="name"], [class*="title"]')?.textContent?.trim();
      const habitaciones = [];

      // En Travelgea los resultados tienen "Tipo de habitación y régimen"
      const filas = card.querySelectorAll('[class*="room"], [class*="tarif"], [class*="option"]');

      filas.forEach(fila => {
        const texto = fila.textContent || '';
        const tipoMatch = texto.match(/(\d+\s*x\s*.+?),/);
        const tipo = tipoMatch ? tipoMatch[1].replace(/^\d+\s*x\s*/, '').trim() : null;

        const regimenEl = fila.querySelector('a, [class*="regime"]');
        const regimen = regimenEl?.textContent?.trim() || 'Todo incluido';

        const precioMatch = texto.match(/Precio\s+USD\s*([\d,.]+)/i);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(',', '')) : null;

        if (tipo && precio) {
          habitaciones.push({
            nombre: tipo,
            regimen,
            precioTotal: precio,
            reembolsable: texto.toLowerCase().includes('reembolsable') || texto.toLowerCase().includes('refundable')
          });
        }
      });

      // Fallback: buscar precio general
      if (habitaciones.length === 0) {
        const precioEl = card.querySelector('[class*="price"], [class*="precio"]');
        const precioText = precioEl?.textContent?.replace(/[^0-9.,]/g, '') || '';
        const precio = parseFloat(precioText.replace(',', ''));
        if (!isNaN(precio) && precio > 0) {
          habitaciones.push({
            nombre: 'Habitación disponible',
            regimen: 'Consultar',
            precioTotal: precio,
            reembolsable: false
          });
        }
      }

      if (nombre && habitaciones.length > 0) {
        hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
      }
    });

    return hoteles;
  });
}

// ─── COMBINAR Y NORMALIZAR RESULTADOS ───
function combinarResultados(tucano, travelgea) {
  const mapa = {};

  // Procesar Tucano
  tucano.forEach(hotel => {
    const key = normalizarNombre(hotel.hotel);
    if (!mapa[key]) {
      mapa[key] = { hotel: hotel.hotel, estrellas: hotel.estrellas, habitaciones: [] };
    }
    hotel.habitaciones.forEach(hab => {
      mapa[key].habitaciones.push({
        ...hab,
        proveedor: 'tucano',
        precioNeto: parseFloat((hab.precioTotal * 0.83).toFixed(2))
      });
    });
  });

  // Procesar Travelgea
  travelgea.forEach(hotel => {
    const key = normalizarNombre(hotel.hotel);
    if (!mapa[key]) {
      mapa[key] = { hotel: hotel.hotel, estrellas: hotel.estrellas, habitaciones: [] };
    }
    hotel.habitaciones.forEach(hab => {
      mapa[key].habitaciones.push({
        ...hab,
        proveedor: 'travelgea',
        precioNeto: parseFloat((hab.precioTotal * 0.88).toFixed(2))
      });
    });
  });

  // Ordenar habitaciones de menor a mayor precio neto
  Object.values(mapa).forEach(hotel => {
    hotel.habitaciones.sort((a, b) => a.precioNeto - b.precioNeto);
  });

  return Object.values(mapa);
}

function normalizarNombre(nombre) {
  return nombre.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatearFechaTucano(fecha) {
  // Tucano usa dd/mm/yyyy
  const [yyyy, mm, dd] = fecha.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

function formatearFechaTravelgea(fecha) {
  // Travelgea usa dd-mm-yyyy
  const [yyyy, mm, dd] = fecha.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

// ─── INICIAR SERVIDOR ───
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});
