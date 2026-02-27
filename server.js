const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
let BOT_URL = process.env.BOT_URL || null;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, botConectado: !!BOT_URL, botUrl: BOT_URL });
});

// El bot local registra su URL acá cuando arranca
app.post('/register-bot', (req, res) => {
  const { botUrl } = req.body;
  if (botUrl) {
    BOT_URL = botUrl;
    console.log('[Railway] Bot registrado:', BOT_URL);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'Falta botUrl' });
  }
});

app.post('/buscar', async (req, res) => {
  const { destino, entrada, noches, adultos } = req.body;
  console.log(`[Búsqueda] destino="${destino}" entrada="${entrada}" noches=${noches} adultos=${adultos}`);

  const botUrl = BOT_URL || process.env.BOT_URL;

  if (!botUrl) {
    return res.json({ ok: false, error: 'Bot local no conectado. Abrí INICIAR.bat en tu computadora.' });
  }

  try {
    const resp = await fetch(`${botUrl}/buscar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destino, entrada, noches, adultos }),
      signal: AbortSignal.timeout(120000) // 2 minutos
    });

    const data = await resp.json();
    const resultados = combinarResultados(data.tucano || [], data.travelgea || []);
    res.json({ ok: true, resultados });
  } catch (err) {
    console.error('[Error]', err.message);
    res.json({ ok: false, error: 'Error al conectar con el bot: ' + err.message });
  }
});

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

app.listen(PORT, () => console.log(`✅ Servidor Railway corriendo en puerto ${PORT}`));
