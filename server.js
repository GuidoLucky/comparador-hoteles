const express = require('express');
const puppeteer = require('puppeteer');
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

function getBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
}

// ─── BOT TUCANO ───
async function buscarTucano(destino, entrada, noches, adultos) {
  console.log('[Tucano] Iniciando...');
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  try {
    // 1. Login
    console.log('[Tucano] Login...');
    await page.goto('https://www.tucanotours.com.ar/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.type('input[name="usuario"]', TUCANO_USER, { delay: 50 });
    await page.type('input[name="password"]', TUCANO_PASS, { delay: 50 });
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
      await page.type('input[name="username"], input[type="email"]', TUCANO_USER, { delay: 50 });
      await page.type('input[type="password"]', TUCANO_PASS, { delay: 50 });
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);
    }

    // 4. Click tab Hoteles
    await page.click('a[href*="hotel"], li:has(a:has-text("Hoteles"))').catch(() => {});
    await page.waitForTimeout(1500);

    // 5. Autocomplete destino
    const inputSelector = 'input.ui-autocomplete-input';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.click(inputSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type(inputSelector, destino, { delay: 100 });
    console.log('[Tucano] Esperando sugerencias autocomplete...');

    // 6. Esperar sugerencias jQuery UI
    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);
    const items = await page.$$('ul.ui-autocomplete li.ui-menu-item');
    console.log('[Tucano] Sugerencias:', items.length);
    if (items.length > 0) {
      await items[0].click();
      await page.waitForTimeout(800);
    }

    // 7. Fecha
    const [yyyy, mm, dd] = entrada.split('-');
    await page.$eval('input[placeholder="Entrada"]', (el, val) => { el.value = val; el.dispatchEvent(new Event('change')); }, `${dd}/${mm}/${yyyy}`).catch(() => {});
    await page.waitForTimeout(400);

    // 8. Noches
    await page.$eval('input[placeholder="Noches"]', (el, val) => { el.value = val; el.dispatchEvent(new Event('change')); }, String(noches)).catch(() => {});
    await page.waitForTimeout(400);

    // 9. Buscar
    await page.click('button:has-text("Buscar")');
    await page.waitForTimeout(7000);
    console.log('[Tucano] URL resultados:', page.url());

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
    const cards = document.querySelectorAll('[class*="hotel-card"], [class*="hotel-item"], [class*="property"], [class*="result"]');
    console.log('Tucano cards:', cards.length);

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="hotel-name"], [class*="name"]')?.textContent?.trim();
      const habitaciones = [];

      card.querySelectorAll('[class*="room"], [class*="tariff"], [class*="rate"]').forEach(row => {
        const nombreHab = row.querySelector('[class*="name"], [class*="type"]')?.textContent?.trim();
        const regimen = row.querySelector('[class*="regime"], [class*="board"], a')?.textContent?.trim() || 'Todo incluido';
        const precioText = (row.querySelector('[class*="price"], [class*="amount"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.');
        const precio = parseFloat(precioText);
        if (nombreHab && !isNaN(precio) && precio > 0) {
          habitaciones.push({ nombre: nombreHab, regimen, precioTotal: precio, reembolsable: row.textContent.includes('eembolsable') });
        }
      });

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
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  try {
    // 1. Login intranet
    console.log('[Travelgea] Login...');
    await page.goto('https://intranet.grupogea.la/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    await page.type('input[type="email"], input[name="email"]', TRAVELGEA_USER, { delay: 50 });
    await page.type('input[type="password"]', TRAVELGEA_PASS, { delay: 50 });
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    console.log('[Travelgea] Post-login:', page.url());

    // 2. Portal
    await page.goto('https://online.travelgea.com.ar/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Travelgea] Portal:', page.url());

    // 3. Autocomplete destino
    const inputSelector = 'input.ui-autocomplete-input, input[placeholder*="Destino"]';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.click(inputSelector);
    await page.type(inputSelector, destino, { delay: 100 });
    console.log('[Travelgea] Esperando sugerencias...');

    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);
    const items = await page.$$('ul.ui-autocomplete li.ui-menu-item');
    console.log('[Travelgea] Sugerencias:', items.length);
    if (items.length > 0) {
      await items[0].click();
      await page.waitForTimeout(800);
    }

    // 4. Fecha
    const [yyyy, mm, dd] = entrada.split('-');
    await page.$eval('input[placeholder*="Llegada"], input[name*="llegada"]', (el, val) => {
      el.value = val; el.dispatchEvent(new Event('change')); el.dispatchEvent(new Event('input'));
    }, `${dd}-${mm}-${yyyy}`).catch(() => {});
    await page.waitForTimeout(400);

    // 5. Noches (select)
    await page.select('select', String(noches)).catch(async () => {
      await page.type('input[placeholder*="Noches"]', String(noches)).catch(() => {});
    });

    // 6. Adultos
    const selects = await page.$$('select');
    if (selects.length >= 2) {
      await page.select(selects[1], String(adultos)).catch(() => {});
    }

    // 7. Buscar
    await page.click('button:has-text("Buscar"), input[value="Buscar"]');
    await page.waitForTimeout(7000);
    console.log('[Travelgea] URL resultados:', page.url());

    const resultados = await extraerTravelgea(page);
    console.log('[Travelgea] Hoteles:', resultados.length);
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
    const cards = document.querySelectorAll('[class*="hotel"], [class*="property"], [class*="item-result"]');

    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="name"], [class*="title"]')?.textContent?.trim();
      const habitaciones = [];

      card.querySelectorAll('[class*="room"], [class*="option"], [class*="tarif"]').forEach(row => {
        const texto = row.textContent || '';
        const tipoMatch = texto.match(/\d+\s*x\s*(.+?)(?:,|Todo|Refund)/);
        const tipo = tipoMatch ? tipoMatch[1].trim() : null;
        const regimen = row.querySelector('a')?.textContent?.trim() || 'Todo incluido';
        const precioMatch = texto.match(/Precio\s+USD\s*([\d,. ]+)/i);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (tipo && precio && precio > 0) {
          habitaciones.push({ nombre: tipo, regimen, precioTotal: precio, reembolsable: texto.toLowerCase().includes('reembolsable') });
        }
      });

      if (!habitaciones.length) {
        const precioMatch = card.textContent?.match(/USD\s*([\d,. ]+)/);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (precio && precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
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
