const express = require('express');
const { chromium } = require('playwright-core');
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

  const [resTucano, resTravelgea] = await Promise.allSettled([
    buscarTucano(destino, entrada, parseInt(noches), parseInt(adultos)),
    buscarTravelgea(destino, entrada, parseInt(noches), parseInt(adultos))
  ]);

  const tucano = resTucano.status === 'fulfilled' ? resTucano.value : [];
  const travelgea = resTravelgea.status === 'fulfilled' ? resTravelgea.value : [];

  if (resTucano.status === 'rejected') console.error('[Tucano] Falló:', resTucano.reason?.message);
  if (resTravelgea.status === 'rejected') console.error('[Travelgea] Falló:', resTravelgea.reason?.message);

  console.log(`[Resultados] Tucano: ${tucano.length}, Travelgea: ${travelgea.length}`);
  res.json({ ok: true, resultados: combinarResultados(tucano, travelgea) });
});

// ─── BOT TUCANO ───
async function buscarTucano(destino, entrada, noches, adultos) {
  console.log('[Tucano] Iniciando...');
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await (await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  })).newPage();

  try {
    // 1. Login tucanotours.com.ar
    console.log('[Tucano] Login...');
    await page.goto('https://www.tucanotours.com.ar/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.fill('input[name="usuario"]', TUCANO_USER);
    await page.fill('input[name="password"]', TUCANO_PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]')
    ]);
    await page.waitForTimeout(2000);
    console.log('[Tucano] Post-login:', page.url());

    // 2. Ir a PriceNavigator
    await page.goto('https://tucanotours.app.pricenavigator.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Tucano] PriceNavigator:', page.url());

    // 3. Si pide login en PriceNavigator
    if (page.url().includes('login')) {
      console.log('[Tucano] Login PriceNavigator...');
      await page.fill('input[name="username"], input[type="email"]', TUCANO_USER);
      await page.fill('input[type="password"]', TUCANO_PASS);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);
    }

    // 4. Click en tab Hoteles
    await page.click('a[href*="hotel"], li:has-text("Hoteles"), .nav-item:has-text("Hoteles")').catch(() => {});
    await page.waitForTimeout(1500);

    // 5. Autocomplete destino — selector exacto de jQuery UI
    const inputDestino = page.locator('input.ui-autocomplete-input, input[placeholder*="ciudad"], input[placeholder*="hotel"]').first();
    await inputDestino.click();
    await inputDestino.fill('');
    await inputDestino.type(destino, { delay: 80 });
    console.log('[Tucano] Escribiendo destino, esperando sugerencias...');

    // 6. Esperar que aparezca el autocomplete ul#ui-id-1
    await page.waitForSelector('ul.ui-autocomplete.ui-front li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);

    // 7. Click en primera sugerencia visible
    const sugerencias = page.locator('ul.ui-autocomplete.ui-front li.ui-menu-item');
    const count = await sugerencias.count();
    console.log('[Tucano] Sugerencias encontradas:', count);
    if (count > 0) {
      await sugerencias.first().click();
      await page.waitForTimeout(800);
    }

    // 8. Fecha entrada
    const [yyyy, mm, dd] = entrada.split('-');
    await page.fill('input[placeholder="Entrada"], input[name*="entrada"]', `${dd}/${mm}/${yyyy}`).catch(() => {});
    await page.waitForTimeout(400);

    // 9. Noches
    await page.fill('input[placeholder="Noches"], input[name*="noches"]', String(noches)).catch(() => {});
    await page.waitForTimeout(400);

    // 10. Buscar
    await page.click('button:has-text("Buscar")');
    await page.waitForTimeout(6000);
    console.log('[Tucano] Resultados URL:', page.url());

    const resultados = await extraerTucano(page);
    console.log('[Tucano] Hoteles:', resultados.length);
    await browser.close();
    return resultados;

  } catch (err) {
    console.error('[Tucano] Error:', err.message);
    // Screenshot para debug
    await page.screenshot({ path: '/tmp/tucano-error.png' }).catch(() => {});
    await browser.close();
    return [];
  }
}

async function extraerTucano(page) {
  return await page.evaluate(() => {
    const hoteles = [];
    // PriceNavigator muestra hotel con clase hotel-card o similar
    const cards = document.querySelectorAll('[class*="hotel-card"], [class*="hotel-item"], [class*="property"]');
    console.log('Tucano: cards encontradas =', cards.length);

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="hotel-name"], [class*="name"]')?.textContent?.trim();
      const habitaciones = [];

      card.querySelectorAll('[class*="room"], [class*="tariff"], [class*="rate"], [class*="hab"]').forEach(row => {
        const nombreHab = row.querySelector('[class*="name"], [class*="type"], [class*="room-type"]')?.textContent?.trim();
        const regimen = row.querySelector('[class*="regime"], [class*="board"], a')?.textContent?.trim() || 'Todo incluido';
        const precioText = (row.querySelector('[class*="price"], [class*="amount"], [class*="total"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.');
        const precio = parseFloat(precioText);
        if (nombreHab && !isNaN(precio) && precio > 0) {
          habitaciones.push({ nombre: nombreHab, regimen, precioTotal: precio, reembolsable: row.textContent.includes('eembolsable') });
        }
      });

      // Fallback precio general
      if (!habitaciones.length) {
        const p = parseFloat((card.querySelector('[class*="price"], [class*="amount"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (p > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: p, reembolsable: false });
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
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await (await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  })).newPage();

  try {
    // 1. Login intranet
    console.log('[Travelgea] Login intranet...');
    await page.goto('https://intranet.grupogea.la/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail"], input[placeholder*="suar"]', TRAVELGEA_USER);
    await page.fill('input[type="password"]', TRAVELGEA_PASS);
    await page.click('button[type="submit"], button:has-text("Ingresar"), button:has-text("Iniciar")');
    await page.waitForTimeout(4000);
    console.log('[Travelgea] Post-login:', page.url());

    // 2. Ir a online.travelgea
    await page.goto('https://online.travelgea.com.ar/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Travelgea] Portal:', page.url());

    // 3. Autocomplete destino — mismo sistema jQuery UI
    const inputDestino = page.locator('input.ui-autocomplete-input, input[placeholder*="Destino"], input[placeholder*="hotel"]').first();
    await inputDestino.click();
    await inputDestino.fill('');
    await inputDestino.type(destino, { delay: 80 });
    console.log('[Travelgea] Escribiendo destino, esperando sugerencias...');

    // 4. Esperar ul.ui-autocomplete li.ui-menu-item
    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);

    const sugerencias = page.locator('ul.ui-autocomplete li.ui-menu-item');
    const count = await sugerencias.count();
    console.log('[Travelgea] Sugerencias:', count);
    if (count > 0) {
      await sugerencias.first().click();
      await page.waitForTimeout(800);
    }

    // 5. Fecha llegada (formato dd-mm-yyyy)
    const [yyyy, mm, dd] = entrada.split('-');
    const llegada = `${dd}-${mm}-${yyyy}`;
    await page.fill('input[placeholder*="Llegada"], input[name*="llegada"], input[name*="checkin"]', llegada).catch(() => {});
    await page.waitForTimeout(400);

    // 6. Noches (select)
    await page.selectOption('select', String(noches)).catch(async () => {
      await page.fill('input[placeholder*="Noches"]', String(noches)).catch(() => {});
    });

    // 7. Adultos
    await page.selectOption('select[name*="adulto"], select:nth-of-type(2)', String(adultos)).catch(() => {});

    // 8. Buscar
    await page.click('button:has-text("Buscar"), input[value="Buscar"]');
    await page.waitForTimeout(7000);
    console.log('[Travelgea] Resultados URL:', page.url());

    const resultados = await extraerTravelgea(page);
    console.log('[Travelgea] Hoteles:', resultados.length);
    await browser.close();
    return resultados;

  } catch (err) {
    console.error('[Travelgea] Error:', err.message);
    await page.screenshot({ path: '/tmp/travelgea-error.png' }).catch(() => {});
    await browser.close();
    return [];
  }
}

async function extraerTravelgea(page) {
  return await page.evaluate(() => {
    const hoteles = [];
    const cards = document.querySelectorAll('[class*="hotel"], [class*="property"], [class*="item-result"]');

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="name"], [class*="title"]')?.textContent?.trim();
      const habitaciones = [];

      card.querySelectorAll('[class*="room"], [class*="option"], [class*="tarif"], [class*="rate"]').forEach(row => {
        const texto = row.textContent || '';
        // "1 x Spa Premium, Todo incluido ... Precio USD 1,621.58"
        const tipoMatch = texto.match(/\d+\s*x\s*(.+?)(?:,|Todo|Refund)/);
        const tipo = tipoMatch ? tipoMatch[1].trim() : null;
        const regimen = row.querySelector('a')?.textContent?.trim() || 'Todo incluido';
        const precioMatch = texto.match(/Precio\s+USD\s*([\d,. ]+)/i);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (tipo && precio && precio > 0) {
          habitaciones.push({ nombre: tipo, regimen, precioTotal: precio, reembolsable: texto.toLowerCase().includes('reembolsable') });
        }
      });

      // Fallback
      if (!habitaciones.length) {
        const precioMatch = card.textContent?.match(/USD\s*([\d,. ]+)/);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
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

  tucano.forEach(h => {
    const key = h.hotel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mapa[key]) mapa[key] = { hotel: h.hotel, estrellas: h.estrellas, habitaciones: [] };
    h.habitaciones.forEach(r => mapa[key].habitaciones.push({ ...r, proveedor: 'tucano', precioNeto: +(r.precioTotal * 0.83).toFixed(2) }));
  });

  travelgea.forEach(h => {
    const key = h.hotel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mapa[key]) mapa[key] = { hotel: h.hotel, estrellas: h.estrellas, habitaciones: [] };
    h.habitaciones.forEach(r => mapa[key].habitaciones.push({ ...r, proveedor: 'travelgea', precioNeto: +(r.precioTotal * 0.88).toFixed(2) }));
  });

  Object.values(mapa).forEach(h => h.habitaciones.sort((a, b) => a.precioNeto - b.precioNeto));
  return Object.values(mapa);
}

app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
