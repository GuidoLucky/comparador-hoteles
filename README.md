# Comparador de Hoteles — Lucky Tour

App para comparar precios de hoteles entre Tucano Tours y Travelgea.

## Variables de entorno requeridas en Railway

| Variable | Descripción |
|---|---|
| `TUCANO_USER` | Usuario de Tucano Tours |
| `TUCANO_PASS` | Contraseña de Tucano Tours |
| `TRAVELGEA_USER` | Usuario de Travelgea |
| `TRAVELGEA_PASS` | Contraseña de Travelgea |

## Lógica de precios

- **Tucano**: precio bruto × 0.83 = precio neto (descuenta 17% comisión)
- **Travelgea**: precio bruto × 0.88 = precio neto (descuenta 12% comisión)
- **TBO**: precio ya es neto (a integrar cuando esté disponible la API)
