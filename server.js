const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const TUCANO_USER = process.env.TUCANO_USER;
const TUCANO_PASS = process.env.TUCANO_PASS;
const TRAVELGEA_USER = process.env.TRAVELGEA_USER;
const TRAVELGEA_PASS = process.env.TRAVELGEA_PASS;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/buscar', async (req, res) => {
  const { destino, entrada, noches, adultos } = req.body;
  console.log(`[Búsqueda] destino="${destino}" entrada="${entrada}" noches=${noches} adultos=${adultos}`);

  if (!destino || !entrada || !noches || !adultos) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  const [resultadosTucano, resultadosTravelgea] = await Promise.allSettled([
    buscarTucano(destino, entrada, parseInt(noches), parseInt(adultos)),
    buscarTravelgea(destino, entrada, parseInt(noches), parseInt(adultos))
  ]);

  const tucano = resultadosTucano.status === 'fulfilled' ? resultadosTucano.value : [];
  const travelgea = resultadosTravelgea.status === 'fulfilled' ? resultadosTravelgea.value : [];

  if (resultadosTucano.status === 'rejected') console.error('[Tucano] Error:', resultadosTucano.reason);
  if (resultadosTravelgea.status === 'rejected') console.error('[Travelgea] Error:', resultadosTravelgea.reason);

  console.log(`[Resultados] Tucano: ${tucano.length} hoteles, Travelgea: ${travelgea.length} hoteles`);

  const resultados = combinarResultados(tucano, travelgea);
  res.json({ ok: true, resultados });
});

// ─── BOT TUCANO ───
async function buscarTucano(destino, entrada, noches, adultos) {
  console.log('[Tucano] Iniciando...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
  const page = await context.newPage();

  try {
    // Login
    console.log('[Tucano] Haciendo login...');
    await page.goto('https://www.tucanotours.com.ar/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.fill('input[name="usuario"]', TUCANO_USER);
    await page.fill('input[name="password"]', TUCANO_PASS);
    await page.click('button[type="submit"], input[type="submit"], .btn-login, button:has-text("Iniciar")');
    await page.waitForTimeout(3000);
    console.log('[Tucano] Login OK, URL:', page.url());

    // Ir a PriceNavigator
    await page.goto('https://tucanotours.app.pricenavigator.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Tucano] PriceNavigator URL:', page.url());

    // Si redirige a login de PriceNavigator, loguearse también
    if (page.url().includes('login')) {
      console.log('[Tucano] Login en PriceNavigator...');
      await page.fill('input[name="username"], input[type="email"], input[placeholder*="usuario"]', TUCANO_USER);
      await page.fill('input[type="password"]', TUCANO_PASS);
      await page.click('button[type="submit"], button:has-text("Ingresar")');
      await page.waitForTimeout(3000);
    }

    // Click en Hoteles
    await page.click('text=Hoteles').catch(() => console.log('[Tucano] No encontré tab Hoteles'));
    await page.waitForTimeout(1500);

    // Campo destino
    const inputDestino = page.locator('input[placeholder*="ciudad"], input[placeholder*="hotel"], input[placeholder*="interés"], input[placeholder*="destino"]').first();
    await inputDestino.fill(destino);
    await page.waitForTimeout(1500);

    // Seleccionar sugerencia
    const sugerencia = page.locator('[class*="suggestion"], [class*="autocomplete"], [class*="item"]').first();
    if (await sugerencia.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sugerencia.click();
      await page.waitForTimeout(500);
    }

    // Fecha
    const [yyyy, mm, dd] = entrada.split('-');
    const fechaTucano = `${dd}/${mm}/${yyyy}`;
    await page.fill('input[placeholder="Entrada"]', fechaTucano).catch(() => {});
    await page.waitForTimeout(300);

    // Noches
    await page.fill('input[placeholder="Noches"]', noches.toString()).catch(() => {});
    await page.waitForTimeout(300);

    // Buscar
    await page.click('button:has-text("Buscar"), .buscar, [class*="search-btn"]');
    await page.waitForTimeout(5000);

    console.log('[Tucano] Extrayendo resultados, URL:', page.url());
    const html = await page.content();
    console.log('[Tucano] HTML length:', html.length);

    const resultados = await extraerTucano(page);
    console.log('[Tucano] Hoteles encontrados:', resultados.length);

    await browser.close();
    return resultados;

  } catch (err) {
    console.error('[Tucano] Error:', err.message);
    await browser.close();
    return [];
  }
}

async function extraerTucano(page) {
  return await page.evaluate(() => {
    const hoteles = [];
    const cards = document.querySelectorAll('[class*="hotel-card"], [class*="property-card"], [class*="hotel-item"], [class*="result-item"]');
    console.log('Tucano cards encontradas:', cards.length);

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="hotel-name"], [class*="property-name"]')?.textContent?.trim();
      const habitaciones = [];

      const tarifas = card.querySelectorAll('[class*="room"], [class*="tariff"], [class*="rate"]');
      tarifas.forEach(t => {
        const nombreHab = t.querySelector('[class*="room-name"], [class*="type"]')?.textContent?.trim();
        const regimen = t.querySelector('[class*="regime"], [class*="board"], a')?.textContent?.trim() || 'Todo incluido';
        const precioText = t.querySelector('[class*="price"], [class*="amount"]')?.textContent?.replace(/[^0-9.,]/g, '') || '';
        const precio = parseFloat(precioText.replace(',', '.'));
        if (nombreHab && !isNaN(precio) && precio > 0) {
          habitaciones.push({ nombre: nombreHab, regimen, precioTotal: precio, reembolsable: t.textContent.includes('eembolsable') });
        }
      });

      if (!habitaciones.length) {
        const p = card.querySelector('[class*="price"], [class*="amount"], [class*="total"]');
        const t = p?.textContent?.replace(/[^0-9.,]/g, '') || '';
        const precio = parseFloat(t.replace(',', '.'));
        if (precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
      }

      if (nombre && habitaciones.length) hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
    });
    return hoteles;
  });
}

// ─── BOT TRAVELGEA ───
async function buscarTravelgea(destino, entrada, noches, adultos) {
  console.log('[Travelgea] Iniciando...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
  const page = await context.newPage();

  try {
    console.log('[Travelgea] Haciendo login...');
    await page.goto('https://intranet.grupogea.la/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Login React app
    await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail"], input[placeholder*="usuario"]', TRAVELGEA_USER);
    await page.fill('input[type="password"]', TRAVELGEA_PASS);
    await page.click('button[type="submit"], button:has-text("Ingresar"), button:has-text("Iniciar")');
    await page.waitForTimeout(4000);
    console.log('[Travelgea] Post-login URL:', page.url());

    // Ir al portal
    await page.goto('https://online.travelgea.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Travelgea] Portal URL:', page.url());

    // Destino
    await page.fill('input[placeholder*="Destino"], input[placeholder*="hotel"], input[placeholder*="interés"]', destino);
    await page.waitForTimeout(1500);

    const sug = page.locator('ul li, [class*="suggestion"], [class*="dropdown-item"]').first();
    if (await sug.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sug.click();
      await page.waitForTimeout(500);
    }

    // Fecha llegada
    const [yyyy, mm, dd] = entrada.split('-');
    const fechaTG = `${dd}-${mm}-${yyyy}`;
    await page.fill('input[placeholder*="Llegada"], input[name*="llegada"]', fechaTG).catch(() => {});

    // Noches (select)
    await page.selectOption('select', noches.toString()).catch(async () => {
      await page.fill('input[placeholder*="Noches"], input[name*="noches"]', noches.toString()).catch(() => {});
    });

    // Adultos
    await page.selectOption('select[name*="adultos"]', adultos.toString()).catch(() => {});

    // Buscar
    await page.click('button:has-text("Buscar"), input[value="Buscar"]');
    await page.waitForTimeout(6000);

    console.log('[Travelgea] Extrayendo, URL:', page.url());

    const resultados = await extraerTravelgea(page);
    console.log('[Travelgea] Hoteles encontrados:', resultados.length);

    await browser.close();
    return resultados;

  } catch (err) {
    console.error('[Travelgea] Error:', err.message);
    await browser.close();
    return [];
  }
}

async function extraerTravelgea(page) {
  return await page.evaluate(() => {
    const hoteles = [];
    const cards = document.querySelectorAll('[class*="hotel"], [class*="property"], [class*="item-hotel"]');

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="name"], [class*="title"]')?.textContent?.trim();
      const habitaciones = [];

      card.querySelectorAll('[class*="room"], [class*="option"], [class*="tarif"]').forEach(row => {
        const texto = row.textContent || '';
        const tipoMatch = texto.match(/(\d+\s*x\s*)(.+?)(,|Todo)/);
        const tipo = tipoMatch ? tipoMatch[2].trim() : null;
        const regimen = row.querySelector('a')?.textContent?.trim() || 'Todo incluido';
        const precioMatch = texto.match(/Precio\s+USD\s*([\d,. ]+)/i);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (tipo && precio) {
          habitaciones.push({ nombre: tipo, regimen, precioTotal: precio, reembolsable: texto.toLowerCase().includes('reembolsable') });
        }
      });

      if (!habitaciones.length) {
        const p = card.querySelector('[class*="price"], [class*="desde"], [class*="amount"]');
        const precio = parseFloat((p?.textContent || '').replace(/[^0-9.]/g, ''));
        if (precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
      }

      if (nombre && habitaciones.length) hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
    });
    return hoteles;
  });
}

// ─── COMBINAR ───
function combinarResultados(tucano, travelgea) {
  const mapa = {};

  tucano.forEach(hotel => {
    const key = hotel.hotel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mapa[key]) mapa[key] = { hotel: hotel.hotel, estrellas: hotel.estrellas, habitaciones: [] };
    hotel.habitaciones.forEach(h => {
      mapa[key].habitaciones.push({ ...h, proveedor: 'tucano', precioNeto: parseFloat((h.precioTotal * 0.83).toFixed(2)) });
    });
  });

  travelgea.forEach(hotel => {
    const key = hotel.hotel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mapa[key]) mapa[key] = { hotel: hotel.hotel, estrellas: hotel.estrellas, habitaciones: [] };
    hotel.habitaciones.forEach(h => {
      mapa[key].habitaciones.push({ ...h, proveedor: 'travelgea', precioNeto: parseFloat((h.precioTotal * 0.88).toFixed(2)) });
    });
  });

  Object.values(mapa).forEach(h => h.habitaciones.sort((a, b) => a.precioNeto - b.precioNeto));
  return Object.values(mapa);
}

app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
