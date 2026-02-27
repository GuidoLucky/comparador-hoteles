const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const TUCANO_USER = process.env.TUCANO_USER;
const TUCANO_PASS = process.env.TUCANO_PASS;
const TRAVELGEA_USER = process.env.TRAVELGEA_USER;
const TRAVELGEA_PASS = process.env.TRAVELGEA_PASS;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, browserless: !!BROWSERLESS_TOKEN, tucano: !!TUCANO_USER, travelgea: !!TRAVELGEA_USER }));

app.post('/buscar', async (req, res) => {
  const { destino, entrada, noches, adultos } = req.body;
  console.log(`[Búsqueda] ${destino} | ${entrada} | ${noches}n | ${adultos}a`);
  if (!BROWSERLESS_TOKEN) return res.json({ ok: false, error: 'Falta BROWSERLESS_TOKEN' });

  const [resTucano, resTravelgea] = await Promise.allSettled([
    buscarTucano(destino, entrada, parseInt(noches), parseInt(adultos)),
    buscarTravelgea(destino, entrada, parseInt(noches), parseInt(adultos))
  ]);

  const tucano    = resTucano.status    === 'fulfilled' ? resTucano.value    : [];
  const travelgea = resTravelgea.status === 'fulfilled' ? resTravelgea.value : [];
  if (resTucano.status    === 'rejected') console.error('[Tucano] Error:', resTucano.reason?.message);
  if (resTravelgea.status === 'rejected') console.error('[Travelgea] Error:', resTravelgea.reason?.message);

  console.log(`[Resultados] Tucano: ${tucano.length}, Travelgea: ${travelgea.length}`);
  res.json({ ok: true, resultados: combinarResultados(tucano, travelgea) });
});

async function getBrowser() {
  const { chromium } = require('playwright-core');
  return chromium.connectOverCDP(`wss://production-sfo.browserless.io?token=${BROWSERLESS_TOKEN}`);
}

// ─── BOT TUCANO ───
async function buscarTucano(destino, entrada, noches, adultos) {
  console.log('[Tucano] Iniciando...');
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. Login tucanotours.com.ar
    await page.goto('https://www.tucanotours.com.ar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.click('a.reg-large.reg-btn24');
    await page.waitForTimeout(1000);
    await page.fill('input[name="email"]', TUCANO_USER);
    await page.fill('input[name="password"]', TUCANO_PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.click('button#login_submit')
    ]);
    await page.waitForTimeout(2000);
    console.log('[Tucano] Login OK:', page.url());

    // 2. Click en Hoteles y Servicios — abre PriceNavigator en nueva pestaña
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 10000 }),
      page.click('a#reservas')
    ]);
    await newPage.waitForLoadState('domcontentloaded');
    await newPage.waitForTimeout(3000);
    console.log('[Tucano] PriceNavigator:', newPage.url());

    // 3. Si pide login en PriceNavigator
    if (newPage.url().includes('login')) {
      console.log('[Tucano] PriceNavigator pide login...');
      // Las credenciales de PriceNavigator son distintas — 
      // intentar con las mismas primero como fallback
      await newPage.fill('input[name="email"], input[type="email"]', TUCANO_USER).catch(() => {});
      await newPage.fill('input[type="password"]', TUCANO_PASS).catch(() => {});
      await newPage.click('button[type="submit"]').catch(() => {});
      await newPage.waitForTimeout(3000);
      console.log('[Tucano] Post-login PN:', newPage.url());
    }

    // 4. Asegurarse de estar en la sección hoteles
    if (!newPage.url().includes('hotel')) {
      await newPage.goto('https://tucanotours.app.pricenavigator.net/#!/hotel', { waitUntil: 'domcontentloaded' });
      await newPage.waitForTimeout(2000);
    }

    // 5. Buscar destino
    await newPage.waitForSelector('input[placeholder*="ciudad"]', { timeout: 10000 });
    await newPage.click('input[placeholder*="ciudad"]');
    await newPage.type('input[placeholder*="ciudad"]', destino, { delay: 80 });
    await newPage.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await newPage.waitForTimeout(500);
    await newPage.locator('ul.ui-autocomplete li.ui-menu-item').first().click();
    await newPage.waitForTimeout(800);
    console.log('[Tucano] Destino seleccionado');

    // 6. Fecha y noches
    const [yyyy, mm, dd] = entrada.split('-');
    await newPage.fill('input[placeholder="Entrada"]', `${dd}/${mm}/${yyyy}`).catch(() => {});
    await newPage.keyboard.press('Tab');
    await newPage.waitForTimeout(300);
    await newPage.fill('input[placeholder="Noches"]', String(noches)).catch(() => {});
    await newPage.waitForTimeout(300);

    // 7. Buscar
    await newPage.click('button:has-text("Buscar")');
    await newPage.waitForTimeout(8000);
    console.log('[Tucano] Resultados URL:', newPage.url());

    const resultados = await extraerTucano(newPage);
    console.log('[Tucano] Hoteles:', resultados.length);
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
    const cards = document.querySelectorAll('[class*="hotel-card"],[class*="hotel-item"],[class*="result-hotel"],[class*="property"]');
    cards.forEach(card => {
      const nombre = (card.querySelector('h2,h3,h4,[class*="hotel-name"],[class*="name"]')?.textContent || '').trim();
      if (!nombre) return;
      const habitaciones = [];
      card.querySelectorAll('[class*="room"],[class*="tariff"],[class*="rate"],[class*="option"]').forEach(row => {
        const nombreHab = (row.querySelector('[class*="name"],[class*="type"]')?.textContent || '').trim();
        const regimen = (row.querySelector('[class*="regime"],a')?.textContent || 'Todo incluido').trim();
        const precio = parseFloat((row.querySelector('[class*="price"],[class*="amount"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (nombreHab && !isNaN(precio) && precio > 0) habitaciones.push({ nombre: nombreHab, regimen, precioTotal: precio, reembolsable: row.textContent.includes('eembolsable') });
      });
      if (!habitaciones.length) {
        const precio = parseFloat((card.querySelector('[class*="price"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
      }
      if (habitaciones.length) hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
    });
    return hoteles;
  });
}

// ─── BOT TRAVELGEA ───
async function buscarTravelgea(destino, entrada, noches, adultos) {
  console.log('[Travelgea] Iniciando...');
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. Login intranet
    await page.goto('https://intranet.grupogea.la/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.fill('input[name="user"]', TRAVELGEA_USER);
    await page.fill('input[name="pass"]', TRAVELGEA_PASS);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    console.log('[Travelgea] Login OK:', page.url());

    // 2. Portal
    await page.goto('https://online.travelgea.com.ar/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log('[Travelgea] Portal:', page.url());

    // 3. Destino — esperar más tiempo por si la página carga lento
    await page.waitForSelector('input.ui-autocomplete-input, input[placeholder*="Destino"], input[placeholder*="destino"]', { timeout: 15000 });
    const inputDestino = page.locator('input.ui-autocomplete-input, input[placeholder*="Destino"]').first();
    await inputDestino.click();
    await inputDestino.type(destino, { delay: 80 });
    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator('ul.ui-autocomplete li.ui-menu-item').first().click();
    await page.waitForTimeout(800);
    console.log('[Travelgea] Destino seleccionado');

    // 4. Fecha y noches
    const [yyyy, mm, dd] = entrada.split('-');
    await page.fill('input[placeholder*="Llegada"]', `${dd}-${mm}-${yyyy}`).catch(() => {});
    await page.waitForTimeout(300);
    await page.selectOption('select', String(noches)).catch(() => {});

    // 5. Buscar
    await page.click('button:has-text("Buscar")');
    await page.waitForTimeout(8000);
    console.log('[Travelgea] Resultados:', page.url());

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
    const cards = document.querySelectorAll('[class*="hotel"],[class*="property"],[class*="result"]');
    cards.forEach(card => {
      const nombre = (card.querySelector('h2,h3,h4,[class*="name"],[class*="title"]')?.textContent || '').trim();
      if (!nombre) return;
      const habitaciones = [];
      card.querySelectorAll('[class*="room"],[class*="option"],[class*="tarif"],[class*="rate"]').forEach(row => {
        const texto = row.textContent || '';
        const tipoMatch = texto.match(/\d+\s*x\s*(.+?)(?:,|Todo|Refund)/);
        const tipo = tipoMatch ? tipoMatch[1].trim() : null;
        const regimen = (row.querySelector('a')?.textContent || 'Todo incluido').trim();
        const precioMatch = texto.match(/Precio\s+USD\s*([\d,. ]+)/i) || texto.match(/USD\s*([\d,.]+)/);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (tipo && precio && precio > 0) habitaciones.push({ nombre: tipo, regimen, precioTotal: precio, reembolsable: texto.toLowerCase().includes('reembolsable') });
      });
      if (!habitaciones.length) {
        const precioMatch = (card.textContent || '').match(/USD\s*([\d,.]+)/);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (precio && precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
      }
      if (habitaciones.length) hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
    });
    return hoteles;
  });
}

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
